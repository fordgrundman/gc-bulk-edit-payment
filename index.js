import express from "express";
import cors from "cors";
import dotenv from "dotenv";

dotenv.config();

const app = express();

//middleware
app.use(cors());
app.use(express.json());

//health check route
app.get("/", (req, res) => {
  res.send("Server is running");
});

//start server
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log("Server listening on port ${PORT}");
});
