import express from "express";
import Stripe from "stripe";
import dotenv from "dotenv";
import { MongoClient, ObjectId } from "mongodb";
import bodyParser from "body-parser";
import cors from "cors";

dotenv.config();

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY, {
  apiVersion: "2025-11-17.clover",
});

const client = new MongoClient(process.env.MONGO_URI);
await client.connect();
const db = client.db();
const customersCollection = db.collection("customers");

const app = express();
app.use(cors());
app.use(express.json());

// ---------------- CREATE CHECKOUT ----------------
app.post("/create-checkout", async (req, res) => {
  const { email } = req.body; // user email from extension
  if (!email) return res.status(400).json({ error: "Email required" });

  // Check if email already exists in DB
  let customer = await customersCollection.findOne({ emails: email });

  let stripeCustomerId;
  if (customer) {
    stripeCustomerId = customer.customer_id;
  } else {
    // Create Stripe customer
    const stripeCustomer = await stripe.customers.create({ email });
    stripeCustomerId = stripeCustomer.id;

    // Insert into DB
    await customersCollection.insertOne({
      customer_id: stripeCustomerId,
      subscription_status: false,
      plan: "price_1Sf6FOJguShk9RUdUS5e2XyS", // your price ID
      emails: [email],
    });
  }

  // Create Stripe Checkout session
  const session = await stripe.checkout.sessions.create({
    mode: "subscription",
    line_items: [{ price: "price_1Sf6FOJguShk9RUdUS5e2XyS", quantity: 1 }],
    customer: stripeCustomerId,
    success_url: `${process.env.FRONTEND_URL}/payment-success?customer_id=${stripeCustomerId}`,
    cancel_url: `${process.env.FRONTEND_URL}/payment-cancel`,
  });

  res.json({ url: session.url });
});

// ---------------------------------- RESOLVE CUSTOMER -------------------------
app.post("/resolve-customer", async (req, res) => {
  const { email } = req.body;
  if (!email) return res.status(400).json({ error: "Email required" });

  const customer = await customersCollection.findOne({ emails: email });

  if (!customer) {
    return res.json({ found: false });
  }

  res.json({
    found: true,
    customer_id: customer.customer_id,
    subscribed: customer.subscription_status,
  });
});

// ------------------------ CHECK SUBSCRIPTION --------------------------------------
app.get("/check-subscription", async (req, res) => {
  const { customer_id } = req.query;
  if (!customer_id)
    return res.status(400).json({ error: "Customer ID required" });

  const customer = await customersCollection.findOne({ customer_id });
  if (!customer) return res.json({ subscribed: false });

  res.json({ subscribed: customer.subscription_status });
});

// ---------------- LINK EMAIL ----------------
app.post("/link-email", async (req, res) => {
  const { customer_id, new_email } = req.body;
  if (!customer_id || !new_email)
    return res.status(400).json({ error: "Missing data" });

  const result = await customersCollection.updateOne(
    { customer_id },
    { $addToSet: { emails: new_email } } // add new email if not exists
  );

  res.json({ success: result.modifiedCount > 0 });
});

// ---------------- STRIPE WEBHOOK ----------------
app.post(
  "/webhook",
  bodyParser.raw({ type: "application/json" }),
  async (req, res) => {
    const sig = req.headers["stripe-signature"];
    const webhookSecret = process.env.STRIPE_WEBHOOK_SECRET;

    let event;
    try {
      event = stripe.webhooks.constructEvent(req.body, sig, webhookSecret);
    } catch (err) {
      return res.status(400).send(`Webhook Error: ${err.message}`);
    }

    if (event.type === "checkout.session.completed") {
      const session = event.data.object;
      const customer_id = session.customer;

      // Update DB to mark subscription active
      await customersCollection.updateOne(
        { customer_id },
        { $set: { subscription_status: true } }
      );

      // Optional: send email with customer_id or show it on success page
      console.log(`Customer ${customer_id} subscribed`);
    }

    res.json({ received: true });
  }
);

app.listen(3000, () => console.log("Server running on port 3000"));
