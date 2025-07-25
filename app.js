import express from "express";
import cookieParser from "cookie-parser";
import cors from "cors";
import dotenv from "dotenv";
dotenv.config();
const app =  express();


app.use(cors(
  {
    origin :  process.env.CORS_ORIGIN, // here we are defining the origin which is frontend's url's 
    credentials : true,
  }
))


app.use(express.json()); 
app.use(express.urlencoded({extended : true})); 
app.use(express.static("public"));
app.use(cookieParser());

import { router } from "./src/routes/users.routes.js";
import { teamrouter } from "./src/routes/teams.routes.js";
import {feedbackRouter} from "./src/routes/feedback.routes.js";

app.use("/api/v1/users" , router);
app.use("/api/v1/team" , teamrouter);
app.use("/api/v1/feedback" , feedbackRouter);
export {app};