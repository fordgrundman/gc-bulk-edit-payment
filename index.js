import express from "express";
import Stripe from "stripe";
import dotenv from "dotenv";
import { MongoClient } from "mongodb";
import bodyParser from "body-parser";
import cors from "cors";

dotenv.config();

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY, {
  apiVersion: "2025-11-17.clover",
});

const client = new MongoClient(process.env.MONGO_URI);
await client.connect();

const db = client.db("gc-bulk-edit-db");
const customersCollection = db.collection("customers");

const FREE_ACTIONS_LIMIT = 100;

const app = express();
app.use(cors());

// ---------------- STRIPE WEBHOOK -----------------
app.post(
  "/webhook",
  // Use raw body for signature verification
  bodyParser.raw({ type: "application/json" }),
  async (req, res) => {
    const sig = req.headers["stripe-signature"];
    const webhookSecret = process.env.STRIPE_WEBHOOK_SECRET;

    let event;

    try {
      // Construct the Stripe event from raw body
      event = stripe.webhooks.constructEvent(req.body, sig, webhookSecret);
    } catch (err) {
      console.error("Webhook signature verification failed:", err.message);
      return res.status(400).send(`Webhook Error: ${err.message}`);
    }

    // Handle checkout.session.completed event
    if (event.type === "checkout.session.completed") {
      const session = event.data.object;
      const customer_id = session.customer;

      try {
        // Update MongoDB subscription status to true
        const result = await customersCollection.updateOne(
          { customer_id },
          { $set: { subscription_status: true } }
        );

        if (result.matchedCount === 0) {
          console.warn(`Webhook: Customer not found in DB: ${customer_id}`);
        } else {
          console.log(
            `Webhook: Customer ${customer_id} subscription marked active`
          );
        }
      } catch (err) {
        console.error("Webhook: Failed to update subscription in DB:", err);
      }
    }

    // Return a 200 response to acknowledge receipt
    res.status(200).json({ received: true });
  }
);

// Now you can safely parse JSON for all other routes
app.use(express.json());

// ---------------- CREATE CHECKOUT ----------------
app.post("/create-checkout", async (req, res) => {
  try {
    let { email } = req.body;
    if (!email) return res.status(400).json({ error: "Email required" });

    const normalizedEmail = email.toLowerCase();
    console.log("Create checkout request:", normalizedEmail);

    // Check if email already exists in DB
    let customer = await customersCollection.findOne({
      emails: { $in: [normalizedEmail] },
    });
    let stripeCustomerId;

    if (customer) {
      stripeCustomerId = customer.customer_id;
      console.log("Found existing customer:", stripeCustomerId);
    } else {
      // Create Stripe customer
      const stripeCustomer = await stripe.customers.create({
        email: normalizedEmail,
      });
      stripeCustomerId = stripeCustomer.id;

      // Insert into DB
      try {
        await customersCollection.insertOne({
          customer_id: stripeCustomerId,
          subscription_status: false,
          plan: "price_1Sf6FOJguShk9RUdUS5e2XyS",
          emails: [normalizedEmail],
        });
        console.log("Inserted new customer:", stripeCustomerId);
      } catch (err) {
        console.error("Failed to insert customer:", err);
        return res
          .status(500)
          .json({ error: "Failed to create customer in DB" });
      }
    }

    // Create Stripe Checkout session
    const session = await stripe.checkout.sessions.create({
      mode: "subscription",
      line_items: [
        {
          price: "price_1Sf6FOJguShk9RUdUS5e2XyS",
          quantity: 1,
        },
      ],
      customer: stripeCustomerId,
      success_url: `https://api-gc-bulk-edit-payment.onrender.com/payment-success?customer_id=${stripeCustomerId}`,
      cancel_url: `https://api-gc-bulk-edit-payment.onrender.com/payment-cancel`,
    });

    res.json({ url: session.url });
  } catch (err) {
    console.error("Create checkout failed:", err);
    res.status(500).json({ error: "Internal server error" });
  }
});

// ---------------------------------- RESOLVE CUSTOMER -------------------------
app.post("/resolve-customer", async (req, res) => {
  try {
    let { email } = req.body;
    if (!email) return res.status(400).json({ error: "Email required" });

    const normalizedEmail = email.toLowerCase();
    const customer = await customersCollection.findOne({
      emails: { $in: [normalizedEmail] },
    });

    if (!customer) return res.json({ found: false });

    res.json({
      found: true,
      customer_id: customer.customer_id,
      subscribed: customer.subscription_status,
      free_actions_remaining:
        customer.free_actions_remaining ?? FREE_ACTIONS_LIMIT,
    });
  } catch (err) {
    console.error("Resolve customer failed:", err);
    res.status(500).json({ error: "Internal server error" });
  }
});

// ------------------------ CHECK SUBSCRIPTION --------------------------------------
app.get("/check-subscription", async (req, res) => {
  try {
    const { customer_id } = req.query;
    if (!customer_id)
      return res.status(400).json({ error: "Customer ID required" });

    const customer = await customersCollection.findOne({ customer_id });
    if (!customer)
      return res.json({
        subscribed: false,
        free_actions_remaining: FREE_ACTIONS_LIMIT,
      });

    res.json({
      subscribed: customer.subscription_status,
      free_actions_remaining:
        customer.free_actions_remaining ?? FREE_ACTIONS_LIMIT,
    });
  } catch (err) {
    console.error("Check subscription failed:", err);
    res.status(500).json({ subscribed: false });
  }
});

// ------------------------ CHECK CAN PERFORM ACTION --------------------------------------
app.post("/check-action", async (req, res) => {
  try {
    const { email, action_count = 1 } = req.body;
    if (!email) return res.status(400).json({ error: "Email required" });

    const normalizedEmail = email.toLowerCase();
    let customer = await customersCollection.findOne({
      emails: { $in: [normalizedEmail] },
    });

    // If customer doesn't exist, create them with free actions
    if (!customer) {
      const stripeCustomer = await stripe.customers.create({
        email: normalizedEmail,
      });

      await customersCollection.insertOne({
        customer_id: stripeCustomer.id,
        subscription_status: false,
        plan: "price_1Sf6FOJguShk9RUdUS5e2XyS",
        emails: [normalizedEmail],
        free_actions_remaining: FREE_ACTIONS_LIMIT,
      });

      customer = await customersCollection.findOne({
        emails: { $in: [normalizedEmail] },
      });
    }

    // Initialize free_actions_remaining if not set
    if (customer.free_actions_remaining === undefined) {
      await customersCollection.updateOne(
        { customer_id: customer.customer_id },
        { $set: { free_actions_remaining: FREE_ACTIONS_LIMIT } }
      );
      customer.free_actions_remaining = FREE_ACTIONS_LIMIT;
    }

    // If subscribed, always allow
    if (customer.subscription_status) {
      return res.json({
        allowed: true,
        subscribed: true,
        free_actions_remaining: customer.free_actions_remaining,
      });
    }

    // Check if enough free actions
    if (customer.free_actions_remaining >= action_count) {
      return res.json({
        allowed: true,
        subscribed: false,
        free_actions_remaining: customer.free_actions_remaining,
      });
    }

    // Not enough actions
    return res.json({
      allowed: false,
      subscribed: false,
      free_actions_remaining: customer.free_actions_remaining,
      message: "No free actions remaining. Please subscribe to continue.",
    });
  } catch (err) {
    console.error("Check action failed:", err);
    res.status(500).json({ error: "Internal server error" });
  }
});

// ------------------------ CONSUME ACTIONS --------------------------------------
app.post("/consume-actions", async (req, res) => {
  try {
    const { email, action_count = 1 } = req.body;
    if (!email) return res.status(400).json({ error: "Email required" });

    const normalizedEmail = email.toLowerCase();
    const customer = await customersCollection.findOne({
      emails: { $in: [normalizedEmail] },
    });

    if (!customer) {
      return res.status(404).json({ error: "Customer not found" });
    }

    // If subscribed, don't consume free actions
    if (customer.subscription_status) {
      return res.json({
        success: true,
        subscribed: true,
        free_actions_remaining:
          customer.free_actions_remaining ?? FREE_ACTIONS_LIMIT,
      });
    }

    // Consume free actions
    const currentActions =
      customer.free_actions_remaining ?? FREE_ACTIONS_LIMIT;
    const newActionsRemaining = Math.max(0, currentActions - action_count);

    await customersCollection.updateOne(
      { customer_id: customer.customer_id },
      { $set: { free_actions_remaining: newActionsRemaining } }
    );

    return res.json({
      success: true,
      subscribed: false,
      free_actions_remaining: newActionsRemaining,
    });
  } catch (err) {
    console.error("Consume actions failed:", err);
    res.status(500).json({ error: "Internal server error" });
  }
});

// ------------------------ GET ACTION STATUS --------------------------------------
app.get("/action-status", async (req, res) => {
  try {
    const { email } = req.query;
    if (!email) return res.status(400).json({ error: "Email required" });

    const normalizedEmail = email.toLowerCase();
    const customer = await customersCollection.findOne({
      emails: { $in: [normalizedEmail] },
    });

    if (!customer) {
      // New user - they get free actions
      return res.json({
        subscribed: false,
        free_actions_remaining: FREE_ACTIONS_LIMIT,
        can_perform_action: true,
      });
    }

    const freeActions = customer.free_actions_remaining ?? FREE_ACTIONS_LIMIT;
    const canPerform = customer.subscription_status || freeActions > 0;

    return res.json({
      subscribed: customer.subscription_status,
      free_actions_remaining: freeActions,
      can_perform_action: canPerform,
    });
  } catch (err) {
    console.error("Get action status failed:", err);
    res.status(500).json({ error: "Internal server error" });
  }
});

// ---------------- UNSUBSCRIBE ----------------
app.post("/unsubscribe", async (req, res) => {
  try {
    const { email } = req.body;
    if (!email) return res.status(400).json({ error: "Email required" });

    const normalizedEmail = email.toLowerCase();
    const customer = await customersCollection.findOne({
      emails: { $in: [normalizedEmail] },
    });

    if (!customer) {
      return res.status(404).json({ error: "Customer not found" });
    }

    if (!customer.subscription_status) {
      return res.json({ success: true, message: "No active subscription" });
    }

    // Get the Stripe subscription and cancel it
    const subscriptions = await stripe.subscriptions.list({
      customer: customer.customer_id,
      status: "active",
    });

    for (const subscription of subscriptions.data) {
      await stripe.subscriptions.cancel(subscription.id);
    }

    // Update database - set subscription_status to false but keep free_actions_remaining
    await customersCollection.updateOne(
      { customer_id: customer.customer_id },
      { $set: { subscription_status: false } }
    );

    console.log(`Unsubscribed customer: ${customer.customer_id}`);
    res.json({ success: true });
  } catch (err) {
    console.error("Unsubscribe failed:", err);
    res.status(500).json({ error: "Failed to unsubscribe" });
  }
});

// ---------------- LINK EMAIL ----------------
app.post("/link-email", async (req, res) => {
  try {
    const { customer_id, new_email } = req.body;
    if (!customer_id || !new_email)
      return res.status(400).json({ error: "Missing data" });

    const normalizedEmail = new_email.toLowerCase();
    const result = await customersCollection.updateOne(
      { customer_id },
      { $addToSet: { emails: normalizedEmail } } // add new email if not exists
    );

    res.json({ success: result.modifiedCount > 0 });
  } catch (err) {
    console.error("Link email failed:", err);
    res.status(500).json({ success: false });
  }
});

// ---------------- PAYMENT SUCCESS PAGE ----------------
app.get("/payment-success", (req, res) => {
  const html = `
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Payment Successful - GC Bulk Edit</title>
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body {
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Oxygen, Ubuntu, sans-serif;
      background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
      min-height: 100vh;
      display: flex;
      align-items: center;
      justify-content: center;
      padding: 20px;
    }
    .container {
      background: white;
      border-radius: 16px;
      padding: 48px;
      max-width: 500px;
      text-align: center;
      box-shadow: 0 20px 60px rgba(0,0,0,0.3);
    }
    .icon {
      width: 80px;
      height: 80px;
      background: #4CAF50;
      border-radius: 50%;
      display: flex;
      align-items: center;
      justify-content: center;
      margin: 0 auto 24px;
    }
    .icon svg {
      width: 40px;
      height: 40px;
      fill: white;
    }
    h1 {
      color: #1a1a1a;
      font-size: 28px;
      margin-bottom: 16px;
    }
    p {
      color: #666;
      font-size: 16px;
      line-height: 1.6;
      margin-bottom: 24px;
    }
    .steps {
      background: #f8f9fa;
      border-radius: 8px;
      padding: 20px;
      text-align: left;
      margin-bottom: 24px;
    }
    .steps h3 {
      color: #333;
      font-size: 14px;
      margin-bottom: 12px;
    }
    .steps ol {
      color: #555;
      font-size: 14px;
      padding-left: 20px;
    }
    .steps li {
      margin-bottom: 8px;
    }
    .note {
      font-size: 13px;
      color: #888;
    }
  </style>
</head>
<body>
  <div class="container">
    <div class="icon">
      <svg viewBox="0 0 24 24"><path d="M9 16.17L4.83 12l-1.42 1.41L9 19 21 7l-1.41-1.41z"/></svg>
    </div>
    <h1>Payment Successful!</h1>
    <p>Thank you for subscribing to GC Bulk Edit. Your subscription is now active.</p>
    <div class="steps">
      <h3>Next steps:</h3>
      <ol>
        <li>Close this tab</li>
        <li>Open your Google Calendar</li>
        <li>Click the GC Bulk Edit extension icon</li>
        <li>Your subscription status should show as Active</li>
      </ol>
    </div>
    <p class="note">If your status doesn't update, try signing out and back in.</p>
  </div>
</body>
</html>
  `;
  res.send(html);
});

// ---------------- PAYMENT CANCEL PAGE ----------------
app.get("/payment-cancel", (req, res) => {
  const html = `
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Payment Canceled - GC Bulk Edit</title>
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body {
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Oxygen, Ubuntu, sans-serif;
      background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
      min-height: 100vh;
      display: flex;
      align-items: center;
      justify-content: center;
      padding: 20px;
    }
    .container {
      background: white;
      border-radius: 16px;
      padding: 48px;
      max-width: 500px;
      text-align: center;
      box-shadow: 0 20px 60px rgba(0,0,0,0.3);
    }
    .icon {
      width: 80px;
      height: 80px;
      background: #ff9800;
      border-radius: 50%;
      display: flex;
      align-items: center;
      justify-content: center;
      margin: 0 auto 24px;
    }
    .icon svg {
      width: 40px;
      height: 40px;
      fill: white;
    }
    h1 {
      color: #1a1a1a;
      font-size: 28px;
      margin-bottom: 16px;
    }
    p {
      color: #666;
      font-size: 16px;
      line-height: 1.6;
      margin-bottom: 24px;
    }
    .info {
      background: #f8f9fa;
      border-radius: 8px;
      padding: 20px;
      margin-bottom: 24px;
    }
    .info p {
      margin: 0;
      font-size: 14px;
    }
    .note {
      font-size: 13px;
      color: #888;
    }
  </style>
</head>
<body>
  <div class="container">
    <div class="icon">
      <svg viewBox="0 0 24 24"><path d="M19 6.41L17.59 5 12 10.59 6.41 5 5 6.41 10.59 12 5 17.59 6.41 19 12 13.41 17.59 19 19 17.59 13.41 12z"/></svg>
    </div>
    <h1>Payment Canceled</h1>
    <p>No worries! Your payment was not processed and you haven't been charged.</p>
    <div class="info">
      <p>You can still use your remaining free actions. When you're ready to subscribe, click the Subscribe button in the extension.</p>
    </div>
    <p class="note">You can close this tab and return to Google Calendar.</p>
  </div>
</body>
</html>
  `;
  res.send(html);
});

app.listen(3000, () => console.log("Server running on port 3000"));
