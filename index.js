// --- Blog Post Validation & Helper Functions ---
function validateBlogPost(post) {
  if (!post) return false;
  const { slug, title, date, description, content } = post;
  return (
    typeof slug === "string" &&
    typeof title === "string" &&
    typeof date === "string" &&
    typeof description === "string" &&
    typeof content === "string"
  );
}

async function getAllBlogPosts() {
  return await blogCollection.find({}, { projection: { _id: 0 } }).toArray();
}

async function getBlogPostBySlug(slug) {
  return await blogCollection.findOne({ slug }, { projection: { _id: 0 } });
}

async function insertBlogPost(post) {
  if (!validateBlogPost(post)) throw new Error("Invalid blog post format");
  await blogCollection.insertOne(post);
}

// Add more helpers as needed (update, delete)
import express from "express";
import Stripe from "stripe";
import dotenv from "dotenv";
import { MongoClient } from "mongodb";
import bodyParser from "body-parser";
import cors from "cors";
import path from "path";
import { fileURLToPath } from "url";
import rateLimit from "express-rate-limit";
import helmet from "helmet";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

dotenv.config();

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY_PROD, {
  apiVersion: "2025-11-17.clover",
});

const client = new MongoClient(process.env.MONGO_URI);
await client.connect();

const db = client.db("gc-bulk-edit-db");
const customersCollection = db.collection("customers");
const blogCollection = db.collection("blogPosts");

const FREE_ACTIONS_LIMIT = 50;

// Email validation helper
function isValidEmail(email) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}

const app = express();

// Security middleware
app.use(
  helmet({
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'self'"],
        scriptSrc: [
          "'self'",
          "'unsafe-inline'",
          "https://connect.facebook.net",
        ],
        imgSrc: ["'self'", "https://www.facebook.com", "data:"],
        connectSrc: ["'self'", "https://www.facebook.com"],
        frameSrc: ["'self'", "https://www.facebook.com"],
      },
    },
  })
);

// Rate limiting
const limiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 500, // limit each IP to 500 requests per windowMs
  message: { error: "Too many requests, please try again later" },
});
app.use(limiter);

// CORS - restrict to specific origins
app.use(
  cors({
    origin: [
      "https://calendar.google.com",
      "https://www.google.com",
      "https://gcbulkedit.dev",
      "https://www.gcbulkedit.dev",
      /^chrome-extension:\/\//, // Allow all Chrome extensions (your extension ID may change)
    ],
    credentials: true,
  })
);

// Serve static files (icons, images)
app.use(express.static(path.join(__dirname, "public")));

// ---------------- STRIPE WEBHOOK -----------------
app.post(
  "/webhook",
  // Use raw body for signature verification
  bodyParser.raw({ type: "application/json" }),
  async (req, res) => {
    const sig = req.headers["stripe-signature"];
    const webhookSecret = process.env.STRIPE_WEBHOOK_SECRET_PROD;

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
    if (!isValidEmail(email))
      return res.status(400).json({ error: "Invalid email format" });

    const normalizedEmail = email.toLowerCase();
    console.log("Create checkout request:", normalizedEmail);

    // Check if email already exists in DB
    let customer = await customersCollection.findOne({
      emails: { $in: [normalizedEmail] },
    });
    let stripeCustomerId;

    if (customer) {
      stripeCustomerId = customer.customer_id;
      console.log("Found existing customer in DB:", stripeCustomerId);

      // Verify the customer exists in Stripe (might be from test mode)
      try {
        await stripe.customers.retrieve(stripeCustomerId);
        console.log("Customer verified in Stripe:", stripeCustomerId);
      } catch (stripeErr) {
        if (stripeErr.code === "resource_missing") {
          // Customer doesn't exist in Stripe (probably from test mode)
          // Create a new Stripe customer and update DB
          console.log("Customer not found in Stripe, creating new one...");
          const newStripeCustomer = await stripe.customers.create({
            email: normalizedEmail,
          });
          stripeCustomerId = newStripeCustomer.id;

          // Update the DB with the new Stripe customer ID
          await customersCollection.updateOne(
            { _id: customer._id },
            {
              $set: {
                customer_id: stripeCustomerId,
                subscription_status: false, // Reset since old subscription was in test mode
              },
            }
          );
          console.log("Updated customer with new Stripe ID:", stripeCustomerId);
        } else {
          throw stripeErr;
        }
      }
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
          plan: process.env.STRIPE_PRICE_ID_PROD,
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
          price: process.env.STRIPE_PRICE_ID_PROD,
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
    if (!isValidEmail(email))
      return res.status(400).json({ error: "Invalid email format" });

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
    if (!isValidEmail(email))
      return res.status(400).json({ error: "Invalid email format" });

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
        plan: process.env.STRIPE_PRICE_ID_PROD,
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
    if (!isValidEmail(email))
      return res.status(400).json({ error: "Invalid email format" });

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
    if (!isValidEmail(email))
      return res.status(400).json({ error: "Invalid email format" });

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
    if (!isValidEmail(email))
      return res.status(400).json({ error: "Invalid email format" });

    const normalizedEmail = email.toLowerCase();
    console.log("Unsubscribe request for:", normalizedEmail);

    const customer = await customersCollection.findOne({
      emails: { $in: [normalizedEmail] },
    });

    if (!customer) {
      console.log("Customer not found in DB:", normalizedEmail);
      return res.status(404).json({ error: "Customer not found" });
    }

    console.log(
      "Found customer:",
      customer.customer_id,
      "subscription_status:",
      customer.subscription_status
    );

    if (!customer.subscription_status) {
      return res.json({ success: true, message: "No active subscription" });
    }

    // Try to get subscriptions from Stripe, but handle missing customer
    let subscriptions;
    try {
      subscriptions = await stripe.subscriptions.list({
        customer: customer.customer_id,
      });
      console.log(
        "Found",
        subscriptions.data.length,
        "subscriptions in Stripe"
      );
    } catch (stripeErr) {
      if (stripeErr.code === "resource_missing") {
        // Customer doesn't exist in Stripe (probably from test mode)
        console.log("Customer not found in Stripe, just updating DB...");
        await customersCollection.updateOne(
          { customer_id: customer.customer_id },
          { $set: { subscription_status: false } }
        );
        return res.json({
          success: true,
          message: "Subscription status reset",
        });
      }
      throw stripeErr;
    }

    // Filter to only active/past_due/trialing subscriptions that can be canceled
    const cancelableStatuses = ["active", "past_due", "trialing", "unpaid"];
    const subscriptionsToCancel = subscriptions.data.filter((sub) =>
      cancelableStatuses.includes(sub.status)
    );

    console.log("Subscriptions to cancel:", subscriptionsToCancel.length);

    for (const subscription of subscriptionsToCancel) {
      try {
        await stripe.subscriptions.cancel(subscription.id);
        console.log("Canceled subscription:", subscription.id);
      } catch (cancelErr) {
        console.error(
          "Failed to cancel subscription",
          subscription.id,
          ":",
          cancelErr.message
        );
      }
    }

    // Update database - set subscription_status to false regardless of Stripe result
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
  <link rel="icon" type="image/png" href="/favicon.png">
  <title>Payment Successful - GC Bulk Edit</title>
  <meta name="robots" content="noindex, nofollow">
  <meta name="description" content="Thank you for subscribing to GC Bulk Edit. Your subscription is now active.">
  
  <!-- Meta Pixel Code -->
  <script>
  !function(f,b,e,v,n,t,s)
  {if(f.fbq)return;n=f.fbq=function(){n.callMethod?
  n.callMethod.apply(n,arguments):n.queue.push(arguments)};
  if(!f._fbq)f._fbq=n;n.push=n;n.loaded=!0;n.version='2.0';
  n.queue=[];t=b.createElement(e);t.async=!0;
  t.src=v;s=b.getElementsByTagName(e)[0];
  s.parentNode.insertBefore(t,s)}(window, document,'script',
  'https://connect.facebook.net/en_US/fbevents.js');
  fbq('init', '1181389844128113');
  fbq('track', 'PageView');
  fbq('track', 'Subscribe', {
    value: 10.00,
    currency: 'USD',
    predicted_ltv: 60.00
  });
  </script>
  <noscript><img height="1" width="1" style="display:none"
  src="https://www.facebook.com/tr?id=1181389844128113&ev=Subscribe&noscript=1"/></noscript>
  <!-- End Meta Pixel Code -->
  
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
  <link rel="icon" type="image/png" href="/favicon.png">
  <title>Payment Canceled - GC Bulk Edit</title>
  <meta name="robots" content="noindex, nofollow">
  <meta name="description" content="Payment was canceled. You can still use your free actions with GC Bulk Edit.">
  
  <!-- Meta Pixel Code -->
  <script>
  !function(f,b,e,v,n,t,s)
  {if(f.fbq)return;n=f.fbq=function(){n.callMethod?
  n.callMethod.apply(n,arguments):n.queue.push(arguments)};
  if(!f._fbq)f._fbq=n;n.push=n;n.loaded=!0;n.version='2.0';
  n.queue=[];t=b.createElement(e);t.async=!0;
  t.src=v;s=b.getElementsByTagName(e)[0];
  s.parentNode.insertBefore(t,s)}(window, document,'script',
  'https://connect.facebook.net/en_US/fbevents.js');
  fbq('init', '1181389844128113');
  fbq('track', 'PageView');
  </script>
  <noscript><img height="1" width="1" style="display:none"
  src="https://www.facebook.com/tr?id=1181389844128113&ev=PageView&noscript=1"/></noscript>
  <!-- End Meta Pixel Code -->
  
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
  <link rel="icon" type="image/png" href="/favicon.png">
  <title>Privacy Policy - GC Bulk Edit</title>
  
  <!-- SEO Meta Tags -->
  <meta name="description" content="Privacy Policy for GC Bulk Edit Chrome extension. Learn how we handle your data, Google Calendar access, and protect your privacy.">
  <meta name="robots" content="index, follow">
  <link rel="canonical" href="https://gcbulkedit.dev/privacy">
  
  <!-- Open Graph -->
  <meta property="og:type" content="website">
  <meta property="og:url" content="https://gcbulkedit.dev/privacy">
  <meta property="og:title" content="Privacy Policy - GC Bulk Edit">
  <meta property="og:description" content="Privacy Policy for GC Bulk Edit Chrome extension. Learn how we handle your data and protect your privacy.">
  <meta property="og:image" content="https://gcbulkedit.dev/icon128.png">
  
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
  <link rel="icon" type="image/png" href="/favicon.png">
  <title>GC Bulk Edit - Bulk Edit, Delete & Move Google Calendar Events</title>
  
  <!-- SEO Meta Tags -->
  <meta name="description" content="Save hours managing your Google Calendar. Select multiple events at once, bulk delete, move events in batches, and customize keyboard shortcuts. Free Chrome extension with 50 free actions.">
  <meta name="keywords" content="Google Calendar, bulk edit, bulk delete, calendar extension, Chrome extension, productivity, time management, calendar events, batch edit">
  <meta name="author" content="GC Bulk Edit">
  <meta name="robots" content="index, follow">
  <link rel="canonical" href="https://gcbulkedit.dev/">
  
  <!-- Open Graph / Facebook -->
  <meta property="og:type" content="website">
  <meta property="og:url" content="https://gcbulkedit.dev/">
  <meta property="og:title" content="GC Bulk Edit - Bulk Edit Google Calendar Events">
  <meta property="og:description" content="Save hours managing your Google Calendar. Select multiple events, bulk delete, and move events in batches. Free Chrome extension.">
  <meta property="og:image" content="https://gcbulkedit.dev/icon128.png">
  <meta property="og:site_name" content="GC Bulk Edit">
  
  <!-- Additional SEO -->
  <meta name="theme-color" content="#667eea">
  <meta name="application-name" content="GC Bulk Edit">
  
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
    .social-links {
      display: flex;
      justify-content: center;
      gap: 20px;
      margin-bottom: 16px;
    }
    .social-links a {
      color: rgba(255, 255, 255, 0.8);
      transition: color 0.2s, transform 0.2s;
    }
    .social-links a:hover {
      color: white;
      transform: scale(1.1);
      text-decoration: none;
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
      <a href="https://forms.gle/2ChNW343VCfkC9Ho7" target="_blank" rel="noopener noreferrer">Feedback</a>
      <a href="https://forms.gle/u6zVcJoor7i5Q1Gd9" target="_blank" rel="noopener noreferrer">Support</a>
      <a href="https://billing.stripe.com/p/login/00w7sMf1R3kDb658GPf7i00" target="_blank" rel="noopener noreferrer">Manage Subscription</a>
      <a href="/privacy">Privacy Policy</a>
    </div>
  </div>
  
  <div class="footer">
    <div class="social-links">
      <a href="https://www.facebook.com/gcbulkedit" target="_blank" rel="noopener noreferrer" title="Facebook">
        <svg viewBox="0 0 24 24" width="24" height="24"><path fill="currentColor" d="M24 12.073c0-6.627-5.373-12-12-12s-12 5.373-12 12c0 5.99 4.388 10.954 10.125 11.854v-8.385H7.078v-3.47h3.047V9.43c0-3.007 1.792-4.669 4.533-4.669 1.312 0 2.686.235 2.686.235v2.953H15.83c-1.491 0-1.956.925-1.956 1.874v2.25h3.328l-.532 3.47h-2.796v8.385C19.612 23.027 24 18.062 24 12.073z"/></svg>
      </a>
      <a href="https://www.instagram.com/gcbulkedit" target="_blank" rel="noopener noreferrer" title="Instagram">
        <svg viewBox="0 0 24 24" width="24" height="24"><path fill="currentColor" d="M12 2.163c3.204 0 3.584.012 4.85.07 3.252.148 4.771 1.691 4.919 4.919.058 1.265.069 1.645.069 4.849 0 3.205-.012 3.584-.069 4.849-.149 3.225-1.664 4.771-4.919 4.919-1.266.058-1.644.07-4.85.07-3.204 0-3.584-.012-4.849-.07-3.26-.149-4.771-1.699-4.919-4.92-.058-1.265-.07-1.644-.07-4.849 0-3.204.013-3.583.07-4.849.149-3.227 1.664-4.771 4.919-4.919 1.266-.057 1.645-.069 4.849-.069zM12 0C8.741 0 8.333.014 7.053.072 2.695.272.273 2.69.073 7.052.014 8.333 0 8.741 0 12c0 3.259.014 3.668.072 4.948.2 4.358 2.618 6.78 6.98 6.98C8.333 23.986 8.741 24 12 24c3.259 0 3.668-.014 4.948-.072 4.354-.2 6.782-2.618 6.979-6.98.059-1.28.073-1.689.073-4.948 0-3.259-.014-3.667-.072-4.947-.196-4.354-2.617-6.78-6.979-6.98C15.668.014 15.259 0 12 0zm0 5.838a6.162 6.162 0 100 12.324 6.162 6.162 0 000-12.324zM12 16a4 4 0 110-8 4 4 0 010 8zm6.406-11.845a1.44 1.44 0 100 2.881 1.44 1.44 0 000-2.881z"/></svg>
      </a>
      <a href="https://www.tiktok.com/@gcbulkedit" target="_blank" rel="noopener noreferrer" title="TikTok">
        <svg viewBox="0 0 24 24" width="24" height="24"><path fill="currentColor" d="M12.525.02c1.31-.02 2.61-.01 3.91-.02.08 1.53.63 3.09 1.75 4.17 1.12 1.11 2.7 1.62 4.24 1.79v4.03c-1.44-.05-2.89-.35-4.2-.97-.57-.26-1.1-.59-1.62-.93-.01 2.92.01 5.84-.02 8.75-.08 1.4-.54 2.79-1.35 3.94-1.31 1.92-3.58 3.17-5.91 3.21-1.43.08-2.86-.31-4.08-1.03-2.02-1.19-3.44-3.37-3.65-5.71-.02-.5-.03-1-.01-1.49.18-1.9 1.12-3.72 2.58-4.96 1.66-1.44 3.98-2.13 6.15-1.72.02 1.48-.04 2.96-.04 4.44-.99-.32-2.15-.23-3.02.37-.63.41-1.11 1.04-1.36 1.75-.21.51-.15 1.07-.14 1.61.24 1.64 1.82 3.02 3.5 2.87 1.12-.01 2.19-.66 2.77-1.61.19-.33.4-.67.41-1.06.1-1.79.06-3.57.07-5.36.01-4.03-.01-8.05.02-12.07z"/></svg>
      </a>
    </div>
    <p>&copy; 2025 GC Bulk Edit. <a href="mailto:codingasford@gmail.com">Contact Us</a></p>
  </div>
</body>
</html>
  `;
  res.send(html);
});

// ---------------- BLOG ENDPOINT ----------------

// GET /blog - list all posts (titles, slugs, date, description)
app.get("/blog", async (req, res) => {
  try {
    const posts = await getAllBlogPosts();
    // Only return summary fields
    const summaries = posts.map(({ slug, title, date, description }) => ({
      slug,
      title,
      date,
      description,
    }));
    res.json(summaries);
  } catch (err) {
    res.status(500).json({ error: "Failed to fetch blog posts" });
  }
});

// GET /blog/:slug - get a single post by slug
app.get("/blog/:slug", async (req, res) => {
  try {
    const post = await getBlogPostBySlug(req.params.slug);
    if (!post) return res.status(404).json({ error: "Blog post not found" });
    res.json(post);
  } catch (err) {
    res.status(500).json({ error: "Failed to fetch blog post" });
  }
});

app.listen(3000, () => console.log("Server running on port 3000"));
