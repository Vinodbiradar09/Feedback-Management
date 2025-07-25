import {Router} from "express";
import { verifyJwt } from "../middlewares/auth.middleware.js";
import {createFeedback , getFeedbackById} from "../controllers/feedback.controllers.js";

const feedbackRouter = Router();

feedbackRouter.route("/createFeedback/:employeeId").post(verifyJwt , createFeedback);

feedbackRouter.route("/getFeedbackDetails/:feedbackId").get(verifyJwt , getFeedbackById);

export {feedbackRouter};