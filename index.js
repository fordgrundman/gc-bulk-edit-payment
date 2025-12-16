import express from "express";
import cors from "cors";

import dotenv from "dotenv";
dotenv.config();

import Stripe from "stripe";
export const stripe = new Stripe(process.env.STRIPE_SECRET_KEY, {
  apiVersion: "2023-10-16",
});

const app = express();
app.use(cors());
app.use(express.json());

app.post("/create-checkout", async (req, res) => {
  try {
    const session = await stripe.checkout.sessions.create({
      mode: "subscription",
      line_items: [{ price: "price_1Sf6FOJguShk9RUdUS5e2XyS", quantity: 1 }],
      success_url: "https://www.gcbulkedit.dev/payment-success",
      cancel_url: "https://www.gcbulkedit.dev/payment-cancel",
    });
    res.json({ url: session.url });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: "Stripe checkout creation failed" });
  }
});

app.get("/", (req, res) => res.send("Server running 🚀"));

//start server
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log("Server listening on port ${PORT}");
});
