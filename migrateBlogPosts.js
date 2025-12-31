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

  // Insert or update posts (by slug)
  for (const post of blogPosts) {
    const exists = await blogCollection.findOne({ slug: post.slug });
    if (!exists) {
      await blogCollection.insertOne(post);
      console.log(`Inserted: ${post.title}`);
    } else {
      // Update existing post
      await blogCollection.updateOne(
        { slug: post.slug },
        {
          $set: {
            title: post.title,
            date: post.date,
            description: post.description,
            content: post.content,
          },
        }
      );
      console.log(`Updated: ${post.title}`);
    }
  }

  await client.close();
  console.log("Migration complete.");
}

main().catch((err) => {
  console.error("Migration failed:", err);
  process.exit(1);
});
