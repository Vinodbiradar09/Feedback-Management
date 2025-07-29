import { asyncHandler } from "../utils/asyncHandler.js";
import { ApiError } from "../utils/ApiError.js";
import { ApiResponse } from "../utils/ApiResponse.js";
import { User } from "../models/users.model.js";
import { Team } from "../models/teams.model.js";
import { Feedback } from "../models/feedback.model.js";
import { Feedbackhistory } from "../models/feedbackHistory.model.js";

const getManagerDashboard = asyncHandler(async(req , res)=>{

})

const getEmployeeDashboard = asyncHandler(async(req , res)=>{

})

export {getManagerDashboard , getEmployeeDashboard};