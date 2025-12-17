import express from "express";
import Stripe from "stripe";
import dotenv from "dotenv";
import { MongoClient } from "mongodb";
import bodyParser from "body-parser";
import cors from "cors";
import path from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

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

// Serve static files (icons, images)
app.use(express.static(path.join(__dirname, "public")));

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
      success_url: `https://gcbulkedit.dev/payment-success?customer_id=${stripeCustomerId}`,
      cancel_url: `https://gcbulkedit.dev/payment-cancel`,
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
    .logo {
      width: 80px;
      height: 80px;
      margin: 0 auto 24px;
    }
    .logo img {
      width: 100%;
      height: 100%;
      border-radius: 16px;
    }
  </style>
</head>
<body>
  <div class="container">
    <div class="logo">
      <img src="/icon128.png" alt="GC Bulk Edit Logo">
    </div>
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
    .logo {
      width: 80px;
      height: 80px;
      margin: 0 auto 24px;
    }
    .logo img {
      width: 100%;
      height: 100%;
      border-radius: 16px;
    }
  </style>
</head>
<body>
  <div class="container">
    <div class="logo">
      <img src="/icon128.png" alt="GC Bulk Edit Logo">
    </div>
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

// ---------------- PRIVACY POLICY PAGE ----------------
app.get("/privacy", (req, res) => {
  const html = `
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Privacy Policy - GC Bulk Edit</title>
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body {
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Oxygen, Ubuntu, sans-serif;
      background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
      min-height: 100vh;
      padding: 40px 20px;
    }
    .container {
      background: white;
      border-radius: 16px;
      padding: 48px;
      max-width: 800px;
      margin: 0 auto;
      box-shadow: 0 20px 60px rgba(0,0,0,0.3);
    }
    .header {
      text-align: center;
      margin-bottom: 40px;
      padding-bottom: 30px;
      border-bottom: 2px solid #f0f0f0;
    }
    .logo {
      width: 80px;
      height: 80px;
      border-radius: 16px;
      margin: 0 auto 20px;
    }
    .logo img {
      width: 100%;
      height: 100%;
      border-radius: 16px;
    }
    h1 {
      color: #1a1a1a;
      font-size: 32px;
      margin-bottom: 8px;
    }
    .subtitle {
      color: #666;
      font-size: 14px;
    }
    .links {
      display: flex;
      gap: 20px;
      justify-content: center;
      margin-top: 20px;
      flex-wrap: wrap;
    }
    .links a {
      display: inline-flex;
      align-items: center;
      gap: 8px;
      padding: 12px 24px;
      background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
      color: white;
      text-decoration: none;
      border-radius: 8px;
      font-size: 14px;
      font-weight: 500;
      transition: transform 0.2s, box-shadow 0.2s;
    }
    .links a:hover {
      transform: translateY(-2px);
      box-shadow: 0 4px 12px rgba(102, 126, 234, 0.4);
    }
    .links a svg {
      width: 18px;
      height: 18px;
      fill: white;
    }
    h2 {
      color: #1a1a1a;
      font-size: 20px;
      margin: 32px 0 16px;
      padding-top: 24px;
      border-top: 1px solid #f0f0f0;
    }
    h2:first-of-type {
      border-top: none;
      padding-top: 0;
      margin-top: 0;
    }
    h3 {
      color: #333;
      font-size: 16px;
      margin: 20px 0 12px;
    }
    p, li {
      color: #555;
      font-size: 15px;
      line-height: 1.7;
      margin-bottom: 12px;
    }
    ul {
      padding-left: 24px;
      margin-bottom: 16px;
    }
    li {
      margin-bottom: 8px;
    }
    .highlight {
      background: #f8f9fa;
      border-left: 4px solid #667eea;
      padding: 16px 20px;
      margin: 20px 0;
      border-radius: 0 8px 8px 0;
    }
    .highlight p {
      margin: 0;
      color: #444;
    }
    .contact {
      background: #f8f9fa;
      border-radius: 12px;
      padding: 24px;
      margin-top: 32px;
      text-align: center;
    }
    .contact h3 {
      margin-top: 0;
    }
    .contact a {
      color: #667eea;
      text-decoration: none;
    }
    .contact a:hover {
      text-decoration: underline;
    }
    @media (max-width: 600px) {
      .container {
        padding: 24px;
      }
      h1 {
        font-size: 24px;
      }
      .links {
        flex-direction: column;
      }
      .links a {
        justify-content: center;
      }
    }
  </style>
</head>
<body>
  <div class="container">
    <div class="header">
      <div class="logo">
        <img src="/icon128.png" alt="GC Bulk Edit Logo">
      </div>
      <h1>GC Bulk Edit</h1>
      <p class="subtitle">Privacy Policy - Last Updated: 12/9/2025</p>
      <div class="links">
        <a href="https://forms.gle/2ChNW343VCfkC9Ho7" target="_blank" rel="noopener noreferrer">
          <svg viewBox="0 0 24 24"><path d="M20 2H4c-1.1 0-1.99.9-1.99 2L2 22l4-4h14c1.1 0 2-.9 2-2V4c0-1.1-.9-2-2-2zm-7 12h-2v-2h2v2zm0-4h-2V6h2v4z"/></svg>
          Feedback Form
        </a>
        <a href="https://forms.gle/u6zVcJoor7i5Q1Gd9" target="_blank" rel="noopener noreferrer">
          <svg viewBox="0 0 24 24"><path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm1 17h-2v-2h2v2zm2.07-7.75l-.9.92C13.45 12.9 13 13.5 13 15h-2v-.5c0-1.1.45-2.1 1.17-2.83l1.24-1.26c.37-.36.59-.86.59-1.41 0-1.1-.9-2-2-2s-2 .9-2 2H8c0-2.21 1.79-4 4-4s4 1.79 4 4c0 .88-.36 1.68-.93 2.25z"/></svg>
          Support
        </a>
        <a href="https://chromewebstore.google.com/detail/fgcgmhgddehkjfjmnjhhnapfocanccph?utm_source=item-share-cb" target="_blank" rel="noopener noreferrer">
          <svg viewBox="0 0 24 24"><path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm-1 17.93c-3.95-.49-7-3.85-7-7.93 0-.62.08-1.21.21-1.79L9 15v1c0 1.1.9 2 2 2v1.93zm6.9-2.54c-.26-.81-1-1.39-1.9-1.39h-1v-3c0-.55-.45-1-1-1H8v-2h2c.55 0 1-.45 1-1V7h2c1.1 0 2-.9 2-2v-.41c2.93 1.19 5 4.06 5 7.41 0 2.08-.8 3.97-2.1 5.39z"/></svg>
          Get Extension
        </a>
      </div>
    </div>

    <h2>1. Introduction</h2>
    <p>The Google Calendar Bulk Edit Extension is a browser extension designed to enhance your experience in Google Calendar. Your privacy is important to us. This Privacy Policy explains what data we collect, how we use it, and how it is protected.</p>
    <p>By using the Extension, you agree to the practices described in this policy.</p>

    <h2>2. Information We Collect</h2>
    
    <h3>2.1 Chrome Extension Data</h3>
    <p>The Extension may store locally on your device:</p>
    <ul>
      <li>User preferences or settings (e.g., highlight colors, UI state, toggle options)</li>
      <li>Temporary selection or UI-related state for the purpose of the extension's functionality</li>
    </ul>
    <div class="highlight">
      <p>This information is stored only on your device and is never transmitted to our servers.</p>
    </div>

    <h3>2.2 Google Calendar API Data (If Applicable)</h3>
    <p>If the Extension interacts with your Google Calendar (e.g., reading events, modifying events), it may access:</p>
    <ul>
      <li>Event metadata (event ID, title, description, start/end times)</li>
      <li>Calendar metadata (calendar IDs, access level)</li>
      <li>Your Google Account email address (only to identify the currently active Google Calendar)</li>
    </ul>
    <p>This data:</p>
    <ul>
      <li>Is only used to perform actions you request inside Google Calendar</li>
      <li>Is not stored on external servers</li>
      <li>Is not shared with any third parties</li>
      <li>Is never used for advertising or profiling</li>
    </ul>
    <div class="highlight">
      <p>The Extension complies fully with the Google API Services User Data Policy, including the Limited Use requirements.</p>
    </div>

    <h2>3. How We Use Your Information</h2>
    <p>We use the information accessed by the Extension solely to:</p>
    <ul>
      <li>Provide functionality such as highlighting, selecting, or modifying events</li>
      <li>Display UI-enhancing features inside Google Calendar</li>
      <li>Ensure actions are performed under the correct Google account</li>
      <li>Provide a smooth and consistent user experience</li>
    </ul>
    <div class="highlight">
      <p>We do not use your data for analytics, tracking, advertising, or selling to third parties.</p>
    </div>

    <h2>4. Data Sharing and Disclosure</h2>
    <p>We do not:</p>
    <ul>
      <li>Sell data</li>
      <li>Share data with advertising providers</li>
      <li>Transfer data to third parties</li>
      <li>Store any personally identifiable information on servers</li>
    </ul>
    <p>Your data stays 100% on your local device unless Google transmits it through its own API as part of actions you initiate (e.g., updating an event).</p>

    <h2>5. Data Security</h2>
    <p>Although the Extension does not transmit your data to external servers, we still take security seriously. All data accessed through the Extension uses:</p>
    <ul>
      <li>OAuth 2.0 secure authentication via Google</li>
      <li>Industry-standard security handled by the Chrome Extensions platform</li>
    </ul>
    <p>No external databases or servers are used.</p>

    <h2>6. Permissions</h2>
    <p>The Extension may request the following permissions:</p>
    <ul>
      <li><strong>identity</strong> - For authenticating with your Google account</li>
      <li><strong>activeTab or scripting</strong> - To interact with Google Calendar pages</li>
      <li><strong>storage</strong> - To save extension preferences locally</li>
      <li><strong>Google Calendar API scopes</strong> (if applicable) only as required for the Extension's features</li>
    </ul>
    <p>We request only the minimal permissions needed for functionality.</p>

    <h2>7. Third-Party Services</h2>
    <p>The Extension uses Google APIs. Your use of Google services is subject to <a href="https://policies.google.com/privacy" target="_blank" rel="noopener noreferrer">Google's Privacy Policy</a>.</p>

    <h2>8. Microtransactions (Future Features)</h2>
    <p>In the future, the Extension may offer optional microtransactions to unlock premium features or additional functionality.</p>
    <p>If such features are added, they will only use data necessary to process the transaction, such as payment information handled through trusted third-party payment processors.</p>
    <p>Any personal or calendar data will not be used for payment processing.</p>

    <h2>9. Children's Privacy</h2>
    <p>The Extension is not intended for children under 13 and does not knowingly collect data from children.</p>

    <h2>10. Changes to This Privacy Policy</h2>
    <p>We may update this Privacy Policy from time to time. Updates will be posted on this page with a revised "Last Updated" date.</p>

    <div class="contact">
      <h3>11. Contact Us</h3>
      <p>If you have questions about this Privacy Policy or the Extension, you can contact us at:</p>
      <p><strong>Email:</strong> <a href="mailto:codingasford@gmail.com">codingasford@gmail.com</a></p>
    </div>
  </div>
</body>
</html>
  `;
  res.send(html);
});

// ---------------- HOME PAGE -----------------
app.get("/", (req, res) => {
  const html = `
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>GC Bulk Edit - Google Calendar Bulk Editing Extension</title>
  <style>
    * {
      margin: 0;
      padding: 0;
      box-sizing: border-box;
    }
    body {
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Oxygen, Ubuntu, Cantarell, sans-serif;
      background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
      min-height: 100vh;
      display: flex;
      flex-direction: column;
      align-items: center;
      justify-content: center;
      padding: 40px 20px;
    }
    .container {
      background: white;
      border-radius: 20px;
      padding: 48px;
      max-width: 600px;
      width: 100%;
      box-shadow: 0 20px 60px rgba(0, 0, 0, 0.3);
      text-align: center;
    }
    .logo {
      width: 120px;
      height: 120px;
      margin: 0 auto 24px;
    }
    .logo img {
      width: 100%;
      height: 100%;
      border-radius: 24px;
      box-shadow: 0 8px 24px rgba(0, 0, 0, 0.15);
    }
    h1 {
      color: #333;
      font-size: 32px;
      margin-bottom: 12px;
    }
    .tagline {
      color: #666;
      font-size: 18px;
      margin-bottom: 32px;
    }
    .features {
      text-align: left;
      background: #f8f9fa;
      border-radius: 12px;
      padding: 24px;
      margin-bottom: 32px;
    }
    .features h3 {
      color: #333;
      margin-bottom: 16px;
      font-size: 18px;
    }
    .features ul {
      list-style: none;
    }
    .features li {
      color: #555;
      padding: 8px 0;
      padding-left: 28px;
      position: relative;
    }
    .features li::before {
      content: "✓";
      position: absolute;
      left: 0;
      color: #4CAF50;
      font-weight: bold;
    }
    .cta-button {
      display: inline-block;
      background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
      color: white;
      text-decoration: none;
      padding: 16px 40px;
      border-radius: 50px;
      font-size: 18px;
      font-weight: 600;
      transition: transform 0.2s, box-shadow 0.2s;
      margin-bottom: 24px;
    }
    .cta-button:hover {
      transform: translateY(-2px);
      box-shadow: 0 8px 24px rgba(102, 126, 234, 0.4);
    }
    .links {
      display: flex;
      justify-content: center;
      gap: 24px;
      flex-wrap: wrap;
    }
    .links a {
      color: #667eea;
      text-decoration: none;
      font-size: 14px;
      transition: color 0.2s;
    }
    .links a:hover {
      color: #764ba2;
      text-decoration: underline;
    }
    .footer {
      margin-top: 40px;
      color: rgba(255, 255, 255, 0.8);
      font-size: 14px;
    }
    .footer a {
      color: white;
      text-decoration: none;
    }
    .footer a:hover {
      text-decoration: underline;
    }
  </style>
</head>
<body>
  <div class="container">
    <div class="logo">
      <img src="/icon128.png" alt="GC Bulk Edit Logo">
    </div>
    <h1>GC Bulk Edit</h1>
    <p class="tagline">Bulk edit, delete, and manage your Google Calendar events with ease</p>
    
    <div class="features">
      <h3>Features</h3>
      <ul>
        <li>Select multiple events at once using a selection box</li>
        <li>Bulk delete events with a single keystroke</li>
        <li>Move many events at once</li>
        <li>Customizable keyboard shortcuts</li>
        <li>Works seamlessly with Google Calendar</li>
      </ul>
    </div>
    
    <a href="https://chromewebstore.google.com/detail/fgcgmhgddehkjfjmnjhhnapfocanccph" class="cta-button" target="_blank" rel="noopener noreferrer">
      Get the Extension
    </a>
    
    <div class="links">
      <a href="https://docs.google.com/forms/d/e/1FAIpQLSe17nZWRz1lQy7E7i-ZP4OC6A_9AjmBbZnAP17KPQhPr5_D3Q/viewform" target="_blank" rel="noopener noreferrer">Feedback</a>
      <a href="https://docs.google.com/forms/d/e/1FAIpQLSe10ZW6zc5XtI1kMH_-cQP_mJKrQK8L7zHvD9BFKwxV4pE3dg/viewform" target="_blank" rel="noopener noreferrer">Support</a>
      <a href="/privacy">Privacy Policy</a>
    </div>
  </div>
  
  <div class="footer">
    <p>&copy; 2025 GC Bulk Edit. <a href="mailto:codingasford@gmail.com">Contact Us</a></p>
  </div>
</body>
</html>
  `;
  res.send(html);
});

app.listen(3000, () => console.log("Server running on port 3000"));
