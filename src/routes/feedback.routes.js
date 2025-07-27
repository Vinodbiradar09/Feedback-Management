import {Router} from "express";
import { verifyJwt } from "../middlewares/auth.middleware.js";
import {createFeedback , getFeedbackById , updateFeedback , softDeleteFeedback , makeIsDeletedFalse , acknowledgeFeedback , getEmployeeFeedback , getManagerFeedback , bulkCreateFeedback , exportEmployeeFeedback} from "../controllers/feedback.controllers.js";

const feedbackRouter = Router();

feedbackRouter.route("/createFeedback/:employeeId").post(verifyJwt , createFeedback);

feedbackRouter.route("/getFeedbackDetails/:feedbackId").get(verifyJwt , getFeedbackById);

feedbackRouter.route("/updateFeedback/:feedbackId").patch(verifyJwt , updateFeedback);

feedbackRouter.route("/softDelete/:feedbackId").patch(verifyJwt , softDeleteFeedback);

feedbackRouter.route("/removeSoftDelete/:feedbackId").patch(verifyJwt , makeIsDeletedFalse);

feedbackRouter.route("/acknowledgement/:feedbackId").patch(verifyJwt , acknowledgeFeedback);

feedbackRouter.route("/getEmployeeFeedback").get(verifyJwt , getEmployeeFeedback);

feedbackRouter.route("/getManagerFeedback").get(verifyJwt , getManagerFeedback);

feedbackRouter.route("/bulkCreateFeedback").post(verifyJwt , bulkCreateFeedback);

feedbackRouter.route("/feedbackExport").post(verifyJwt , exportEmployeeFeedback);
export {feedbackRouter};