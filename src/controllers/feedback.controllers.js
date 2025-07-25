import { asyncHandler } from "../utils/asyncHandler.js";
import { ApiError } from "../utils/ApiError.js";
import { ApiResponse } from "../utils/ApiResponse.js";
import { User } from "../models/users.model.js";
import { Team } from "../models/teams.model.js";
import {Feedback} from "../models/feedback.model.js";
import mongoose from "mongoose";

const createFeedback = asyncHandler(async(req , res)=>{
    const { employeeId } = req.params;
    const {strengths , areasToImprove , sentiment} = req.body;
    const manager = req.user;

    if(!employeeId || !mongoose.isValidObjectId(employeeId)){
        throw new ApiError(400, "Invalid employee ID");
    }
    if([strengths , areasToImprove , sentiment].some(detail => detail.trim() === "")){
        throw new ApiError(404 , "All the fields are required to create the feedback for the employee");
    }
    if(!manager || manager.role !== "manager"){
        throw new ApiError(403, "Only managers can create feedback");
    }
    const employeeObjectId = new mongoose.Types.ObjectId(employeeId);
    const [validationResult] = await Team.aggregate([
        {
            $match : {
                managerId : new mongoose.Types.ObjectId(manager._id),   
                employeeIds : new mongoose.Types.ObjectId(employeeId),
                isActive : true
            }
        },
        {
            $project : {
                isValid : {
                    $and : [
                        {$isArray : "$employeeIds"},
                        {$in : [employeeObjectId , "$employeeIds"]},
                        {$eq : [ "$managerId" ,manager._id ]},
                    ]
                },
                teamName : 1,
                employeeCount: { $size: "$employeeIds" }
            }
        },
         { $limit: 1 }
    ]);

    if(!validationResult || !validationResult.isValid){
       throw new ApiError(403, "You can only provide feedback to your current team members");
    }
    const feedback = await Feedback.create({
        fromManagerId : manager._id,
        toEmployeeId : employeeId,
        strengths,
        areasToImprove,
        sentiment,
        // isAcknowledged : false,
        // acknowledgedAt : null
    });

    if(!feedback){
        throw new ApiError(404 , "Failed to create the feedback for the employee");
    }
    res.status(200).json(new ApiResponse(200 , feedback , "successfully created the feedback"));

})

const getFeedbackById = asyncHandler(async(req , res)=>{
    const {feedbackId} = req.params;
    const authorizedUser = req.user;
    if(!feedbackId || !mongoose.isValidObjectId(feedbackId)){
        throw new ApiError(402 , "Invalid feedback id format");
    }
    if (!["admin", "manager"].includes(authorizedUser.role)) {
        throw new ApiError(403, "Only manager and admins can access feedback details");
    }

    if(authorizedUser.role === "manager"){
        const validManager = await Feedback.findOne({
            _id : feedbackId,
            fromManagerId : authorizedUser._id,
        })

        if(!validManager){
            throw new ApiError(403 , "You are not the manager for this feedback so you can't access the details");
        }
    }
    const result = await Feedback.aggregate([
        {
            $match : {
                _id : new mongoose.Types.ObjectId(feedbackId),
                isDeleted : false
            }
        },
        {
            $lookup : {
                from : "users",
                localField : "fromManagerId",
                foreignField : "_id",
                as : "managerDetails",
                pipeline : [
                    {
                        $project : {
                            name : 1,
                            email : 1,
                            userProfile : 1,
                            role : 1
                        }
                    }
                ]
            }
        },
        {
            $lookup : {
                from : "users",
                localField : "toEmployeeId",
                foreignField : "_id",
                as : "employeeDetails",
                pipeline : [
                    {
                        $project : {
                            name : 1,
                            email : 1,
                            userProfile : 1,
                            role :1
                        }
                    }
                ]
            }
        },
        {
            $addFields : {
                manager : {
                    $arrayElemAt: ["$managerDetails", 0]
                },
                 employee: { $arrayElemAt: ["$employeeDetails", 0] }
            }
        },
        {
            $project : {
                manager : 1,
                employee : 1,
                strengths : 1,
                areasToImprove : 1,
                sentiment : 1,
                isAcknowledged : 1,
                acknowledgedAt : 1,
            }
        }
    ])

    if(!result || !result.length){
      throw new ApiError(404, "Feedback not found or access denied");
    }
    res.status(200).json(new ApiResponse(200 , result[0] , "Successfully fetched the feedback details"));
})

const updateFeedback = asyncHandler(async(req , res)=>{
    // only managers can update the feedback , check for the manager
    // 
})
export { createFeedback , getFeedbackById };