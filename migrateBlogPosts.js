// migrateBlogPosts.js
// Script to migrate blogPosts.js posts into MongoDB
import dotenv from "dotenv";
import { MongoClient } from "mongodb";
import blogPosts from "./blogPosts.js";

dotenv.config();

async function main() {
  const client = new MongoClient(process.env.MONGO_URI);
  await client.connect();
  const db = client.db("gc-bulk-edit-db");
  const blogCollection = db.collection("blogPosts");

  // Remove all existing posts (optional, for clean migration)
  // await blogCollection.deleteMany({});

  // Insert posts if they don't already exist (by slug)
  for (const post of blogPosts) {
    const exists = await blogCollection.findOne({ slug: post.slug });
    if (!exists) {
      await blogCollection.insertOne(post);
      console.log(`Inserted: ${post.title}`);
    } else {
      console.log(`Skipped (already exists): ${post.title}`);
    }
  }

  await client.close();
  console.log("Migration complete.");
}

main().catch((err) => {
  console.error("Migration failed:", err);
  process.exit(1);
});
