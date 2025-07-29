import {Router} from "express";
import { verifyJwt } from "../middlewares/auth.middleware.js";
import {getFeedbackHistory , getFeedbackHistoryById , deleteFeedbackHistory , getFeedbackHistoryByManager} from "../controllers/feedbackHistory.controllers.js"

const feedbackHistoryRouter = Router();

feedbackHistoryRouter.route("/getFeedbackHistory/:feedbackId").get(verifyJwt , getFeedbackHistory);

feedbackHistoryRouter.route("/getHistory/:feedbackHistoryId").get(verifyJwt , getFeedbackHistoryById);

feedbackHistoryRouter.route("/deleteHistory/:feedbackHistoryId").delete(verifyJwt , deleteFeedbackHistory);

feedbackHistoryRouter.route("/getHistoryByManager").get(verifyJwt , getFeedbackHistoryByManager);
feedbackHistoryRouter.route("/getHistoryByManager/:managerId").get(verifyJwt , getFeedbackHistoryByManager);

export {feedbackHistoryRouter};