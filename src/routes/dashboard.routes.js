import {Router} from "express";
import { verifyJwt } from "../middlewares/auth.middleware.js";

const dashboardRouter = Router();

export {dashboardRouter};