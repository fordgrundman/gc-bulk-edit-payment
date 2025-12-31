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
  // Sanitize slug to prevent NoSQL injection
  if (typeof slug !== "string" || slug.length > 200) return null;
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
          "https://chimpstatic.com",
        ],
        styleSrc: [
          "'self'",
          "'unsafe-inline'",
          "https://cdn-images.mailchimp.com",
        ],
        formAction: ["'self'", "https://dev.us16.list-manage.com"],
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

// Serve privacy page at /privacy
app.get("/privacy", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "privacy.html"));
});

// Serve terms page at /terms
app.get("/terms", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "terms.html"));
});

// Serve payment pages without .html extension
app.get("/payment-success", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "payment-success.html"));
});

app.get("/payment-cancel", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "payment-cancel.html"));
});

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
          created_at: new Date(),
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
    // Validate customer_id format (Stripe customer IDs start with "cus_")
    if (
      typeof customer_id !== "string" ||
      customer_id.length > 100 ||
      !customer_id.startsWith("cus_")
    )
      return res.status(400).json({ error: "Invalid customer ID format" });

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
        created_at: new Date(),
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

    // If subscribed, don't consume free actions but track last action
    if (customer.subscription_status) {
      await customersCollection.updateOne(
        { customer_id: customer.customer_id },
        { $set: { last_action_at: new Date() } }
      );
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
      {
        $set: {
          free_actions_remaining: newActionsRemaining,
          last_action_at: new Date(),
        },
      }
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
    if (typeof customer_id !== "string" || customer_id.length > 100)
      return res.status(400).json({ error: "Invalid customer_id" });
    if (!isValidEmail(new_email))
      return res.status(400).json({ error: "Invalid email format" });

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
// Served from public/payment-success.html

// ---------------- PAYMENT CANCEL PAGE ----------------
// Served from public/payment-cancel.html

// ---------------- PRIVACY POLICY PAGE ----------------
// Served from public/privacy.html

// ---------------- HOME PAGE -----------------
// Served from public/index.html

// ---------------- BLOG API ENDPOINTS ----------------

// GET /api/blog - list all posts (titles, slugs, date, description)
app.get("/api/blog", async (req, res) => {
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

// GET /api/blog/:slug - get a single post by slug
app.get("/api/blog/:slug", async (req, res) => {
  try {
    const post = await getBlogPostBySlug(req.params.slug);
    if (!post) return res.status(404).json({ error: "Blog post not found" });
    res.json(post);
  } catch (err) {
    res.status(500).json({ error: "Failed to fetch blog post" });
  }
});

// ---------------- USER PREFERENCES API ----------------

// GET /preferences - Get user preferences by email
app.get("/preferences", async (req, res) => {
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
      // User doesn't exist yet - return empty preferences
      return res.json({ preferences: null });
    }

    // Return preferences (may be undefined if never set)
    res.json({
      preferences: customer.preferences || null,
    });
  } catch (err) {
    console.error("Get preferences failed:", err);
    res.status(500).json({ error: "Failed to fetch preferences" });
  }
});

// POST /preferences - Save user preferences by email
app.post("/preferences", async (req, res) => {
  try {
    const { email, preferences } = req.body;
    if (!email) return res.status(400).json({ error: "Email required" });
    if (!isValidEmail(email))
      return res.status(400).json({ error: "Invalid email format" });
    if (!preferences || typeof preferences !== "object")
      return res.status(400).json({ error: "Preferences object required" });

    const normalizedEmail = email.toLowerCase();

    // Validate preferences structure (only allow specific fields)
    const allowedFields = [
      "keybinds",
      "highlightColor",
      "hideAllDayTasks",
      "hideLeftSidebar",
      "hideRightSidebar",
      "hourRange",
    ];
    const sanitizedPrefs = {};
    for (const key of allowedFields) {
      if (preferences[key] !== undefined) {
        sanitizedPrefs[key] = preferences[key];
      }
    }

    // Upsert: update if exists, create minimal record if not
    const result = await customersCollection.updateOne(
      { emails: { $in: [normalizedEmail] } },
      {
        $set: { preferences: sanitizedPrefs },
        $setOnInsert: {
          emails: [normalizedEmail],
          subscription_status: false,
          free_actions_remaining: FREE_ACTIONS_LIMIT,
          created_at: new Date(),
        },
      },
      { upsert: true }
    );

    res.json({ success: true, updated: result.modifiedCount > 0 });
  } catch (err) {
    console.error("Save preferences failed:", err);
    res.status(500).json({ error: "Failed to save preferences" });
  }
});

app.listen(3000, () => console.log("Server running on port 3000"));
