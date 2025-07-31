import {Router} from "express";
import { verifyJwt } from "../middlewares/auth.middleware.js";
import {getManagerDashboard , getEmployeeDashboard} from "../controllers/dashboard.controllers.js";
const dashboardRouter = Router();

dashboardRouter.route("/managerDashboard").get(verifyJwt , getManagerDashboard );

dashboardRouter.route("/employeeDashboard").get(verifyJwt , getEmployeeDashboard);
export {dashboardRouter};