import express from "express";
import Stripe from "stripe";
import dotenv from "dotenv";
import { MongoClient } from "mongodb";
import cors from "cors";
import bodyParser from "body-parser";

dotenv.config();

// ------------------- STRIPE SETUP -------------------
const stripe = new Stripe(process.env.STRIPE_SECRET_KEY, {
  apiVersion: "2025-11-17.clover",
});

// ------------------- MONGODB SETUP -------------------
// MongoClient options with TLS enabled for Atlas
const client = new MongoClient(process.env.MONGO_URI, {
  tls: true,
  tlsAllowInvalidCertificates: false, // true only for dev/local testing
  serverSelectionTimeoutMS: 5000, // fail fast if cannot connect
});

try {
  await client.connect();
  console.log("✅ MongoDB connected successfully");
} catch (err) {
  console.error("❌ MongoDB connection failed:", err);
  process.exit(1);
}

const db = client.db(); // uses database in URI
const customersCollection = db.collection("customers");

// ------------------- EXPRESS SETUP -------------------
const app = express();
app.use(cors());
app.use(express.json());

// Use raw body parser only for Stripe webhooks
app.use("/webhook", bodyParser.raw({ type: "application/json" }));

// ------------------- HELPER -------------------
const FRONTEND_URL = process.env.FRONTEND_URL || "http://localhost:5173";

// ------------------- ENDPOINTS -------------------
// Example: Create Checkout
app.post("/create-checkout", async (req, res) => {
  const { email } = req.body;
  if (!email) return res.status(400).json({ error: "Email required" });

  let customer = await customersCollection.findOne({
    emails: email.toLowerCase(),
  });

  let stripeCustomerId;
  if (customer) {
    stripeCustomerId = customer.customer_id;
  } else {
    const stripeCustomer = await stripe.customers.create({ email });
    stripeCustomerId = stripeCustomer.id;

    await customersCollection.insertOne({
      customer_id: stripeCustomerId,
      subscription_status: false,
      plan: "price_1Sf6FOJguShk9RUdUS5e2XyS",
      emails: [email.toLowerCase()],
    });
  }

  const session = await stripe.checkout.sessions.create({
    mode: "subscription",
    line_items: [{ price: "price_1Sf6FOJguShk9RUdUS5e2XyS", quantity: 1 }],
    customer: stripeCustomerId,
    success_url: `${FRONTEND_URL}/payment-success?customer_id=${stripeCustomerId}`,
    cancel_url: `${FRONTEND_URL}/payment-cancel`,
  });

  res.json({ url: session.url });
});

// ------------------- START SERVER -------------------
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`🚀 Server running on port ${PORT}`);
});
