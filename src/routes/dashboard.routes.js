import {Router} from "express";
import { verifyJwt } from "../middlewares/auth.middleware.js";
import {getManagerDashboard} from "../controllers/dashboard.controllers.js";
const dashboardRouter = Router();

dashboardRouter.route("/managerDashboard").get(verifyJwt , getManagerDashboard );
export {dashboardRouter};