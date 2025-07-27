import { asyncHandler } from "../utils/asyncHandler.js";
import { ApiError } from "../utils/ApiError.js";
import { ApiResponse } from "../utils/ApiResponse.js";
import { User } from "../models/users.model.js";
import { Team } from "../models/teams.model.js";
import { Feedback } from "../models/feedback.model.js";
import { Feedbackhistory } from "../models/feedbackHistory.model.js";
import mongoose, { version } from "mongoose";
import { text } from "express";

const createFeedback = asyncHandler(async (req, res) => {
    const { employeeId } = req.params;
    const { strengths, areasToImprove, sentiment } = req.body;
    const manager = req.user;

    if (!employeeId || !mongoose.isValidObjectId(employeeId)) {
        throw new ApiError(400, "Invalid employee ID");
    }
    if ([strengths, areasToImprove, sentiment].some(detail => detail.trim() === "")) {
        throw new ApiError(404, "All the fields are required to create the feedback for the employee");
    }
    if (!manager || manager.role !== "manager") {
        throw new ApiError(403, "Only managers can create feedback");
    }
    const employeeObjectId = new mongoose.Types.ObjectId(employeeId);
    const [validationResult] = await Team.aggregate([
        {
            $match: {
                managerId: new mongoose.Types.ObjectId(manager._id),
                employeeIds: new mongoose.Types.ObjectId(employeeId),
                isActive: true
            }
        },
        {
            $project: {
                isValid: {
                    $and: [
                        { $isArray: "$employeeIds" },
                        { $in: [employeeObjectId, "$employeeIds"] },
                        { $eq: ["$managerId", manager._id] },
                    ]
                },
                teamName: 1,
                employeeCount: { $size: "$employeeIds" }
            }
        },
        { $limit: 1 }
    ]);

    if (!validationResult || !validationResult.isValid) {
        throw new ApiError(403, "You can only provide feedback to your current team members");
    }
    const feedback = await Feedback.create({
        fromManagerId: manager._id,
        toEmployeeId: employeeId,
        strengths,
        areasToImprove,
        sentiment,
        // isAcknowledged : false,
        // acknowledgedAt : null
    });

    if (!feedback) {
        throw new ApiError(404, "Failed to create the feedback for the employee");
    }
    res.status(200).json(new ApiResponse(200, feedback, "successfully created the feedback"));

})

const getFeedbackById = asyncHandler(async (req, res) => {
    const { feedbackId } = req.params;
    const authorizedUser = req.user;
    if (!feedbackId || !mongoose.isValidObjectId(feedbackId)) {
        throw new ApiError(402, "Invalid feedback id format");
    }
    if (!["admin", "manager"].includes(authorizedUser.role)) {
        throw new ApiError(403, "Only manager and admins can access feedback details");
    }

    if (authorizedUser.role === "manager") {
        const validManager = await Feedback.findOne({
            _id: feedbackId,
            fromManagerId: authorizedUser._id,
        })

        if (!validManager) {
            throw new ApiError(403, "You are not the manager for this feedback so you can't access the details");
        }
    }
    const result = await Feedback.aggregate([
        {
            $match: {
                _id: new mongoose.Types.ObjectId(feedbackId),
                isDeleted: false
            }
        },
        {
            $lookup: {
                from: "users",
                localField: "fromManagerId",
                foreignField: "_id",
                as: "managerDetails",
                pipeline: [
                    {
                        $project: {
                            name: 1,
                            email: 1,
                            userProfile: 1,
                            role: 1
                        }
                    }
                ]
            }
        },
        {
            $lookup: {
                from: "users",
                localField: "toEmployeeId",
                foreignField: "_id",
                as: "employeeDetails",
                pipeline: [
                    {
                        $project: {
                            name: 1,
                            email: 1,
                            userProfile: 1,
                            role: 1
                        }
                    }
                ]
            }
        },
        {
            $addFields: {
                manager: {
                    $arrayElemAt: ["$managerDetails", 0]
                },
                employee: { $arrayElemAt: ["$employeeDetails", 0] }
            }
        },
        {
            $project: {
                manager: 1,
                employee: 1,
                strengths: 1,
                areasToImprove: 1,
                sentiment: 1,
                isAcknowledged: 1,
                acknowledgedAt: 1,
            }
        }
    ])

    if (!result || !result.length) {
        throw new ApiError(404, "Feedback not found or access denied");
    }
    res.status(200).json(new ApiResponse(200, result[0], "Successfully fetched the feedback details"));
})

const updateFeedback = asyncHandler(async (req, res) => {
    const manager = req.user;
    const { strengths, areasToImprove, sentiment } = req.body;
    const { feedbackId } = req.params;

    if (!feedbackId || !mongoose.isValidObjectId(feedbackId)) {
        throw new ApiError(400, "Invalid object id format");
    }
    if (manager.role !== "manager") {
        throw new ApiError(403, "Only managers can update feedback");
    }
    const updatedDetails = {};

    if (strengths !== undefined && strengths !== null) {
        if (typeof strengths !== "string" || strengths.trim().length === 0) {
            throw new ApiError(400, "Strengths must be a non-empty string");
        }
        updatedDetails.strengths = strengths.trim();
    }

    if (areasToImprove !== undefined && areasToImprove !== null) {
        if (typeof areasToImprove !== "string" || areasToImprove.trim().length === 0) {
            throw new ApiError(400, "Areas to improve must be a non-empty string");
        }
        updatedDetails.areasToImprove = areasToImprove.trim();
    }

    if (sentiment !== undefined && sentiment !== null) {
        const validSentiments = ['positive', 'neutral', 'negative'];
        if (!validSentiments.includes(sentiment)) {
            throw new ApiError(400, "Sentiment must be positive, neutral, or negative");
        }
        updatedDetails.sentiment = sentiment
    }

    if (Object.keys(updatedDetails).length === 0) {
        throw new ApiError(400, "At least one field is required to update feedback");
    }
    const session = await mongoose.startSession();
    try {
        await session.withTransaction(async () => {
            const existingFeedback = await Feedback.findOne({
                _id: feedbackId,
                fromManagerId: manager._id,
                isDeleted: false,
            }).session(session);
            if (!existingFeedback) {
                throw new ApiError(404, "Feedback not found or you don't have permission to update it");
            }

            const originalData = {
                strengths: existingFeedback.strengths,
                areasToImprove: existingFeedback.areasToImprove,
                sentiment: existingFeedback.sentiment,
                version: existingFeedback.version
            }
            const updatedFeedback = await Feedback.findByIdAndUpdate(feedbackId,
                {
                    $set: updatedDetails,
                    $inc: { version: 1 }
                },
                {
                    new: true,
                    runValidators: true,
                    session: session
                });

            if (!updatedFeedback) {
                throw new ApiError(500, "Failed to update feedback");
            }
            console.log("u", updatedFeedback);
            await Feedbackhistory.create([{
                feedbackId: feedbackId,
                previousData: originalData,
                editedByManagersId: manager._id,
                editReason: `Updated fields: ${Object.keys(updatedDetails).join(', ')}`,
                editedAt: new Date()
            }], { session });
            res.status(200).json(
                new ApiResponse(200, updatedFeedback, "Feedback updated successfully")
            );

        })
    } catch (error) {
        if (error instanceof ApiError) {
            throw error;
        }
        throw new ApiError(500, "Failed to update feedback");
    }
    finally {
        await session.endSession();
    }
})
const softDeleteFeedback = asyncHandler(async (req, res) => {
    const { feedbackId } = req.params;
    const manager = req.user;
    if (!feedbackId || !mongoose.isValidObjectId(feedbackId)) {
        throw new ApiError(400, "Invalid feedback ID format");
    }
    if (manager.role !== "manager") {
        throw new ApiError(403, "Only managers can soft delete feedback");
    }
    const existingFeedback = await Feedback.findOne({
        _id: feedbackId,
        fromManagerId: manager._id,
        isDeleted: false,
        isAcknowledged: true
    });

    if (!existingFeedback) {
        throw new ApiError(
            404,
            "Feedback not found, or employee has not acknowledged it yet, or you're not authorized."
        );
    }
    const softDeletion = await Feedback.findByIdAndUpdate(
        feedbackId,
        {
            $set: {
                isDeleted: true,
                deletedAt: new Date()
            },
            $inc: { version: 1 }
        },
        {
            new: true,
            runValidators: true,
            projection: {
                _id: 1,
                toEmployeeId: 1,
                isDeleted: 1,
                deletedAt: 1,
                version: 1
            }
        }
    );
    if (!softDeletion) {
        const [feedbackExists, isManager, isAcknowledged] = await Promise.all([
            Feedback.exists({ _id: feedbackId, isDeleted: false }),
            Feedback.exists({ _id: feedbackId, fromManagerId: manager._id }),
            Feedback.exists({ _id: feedbackId, isAcknowledged: true })
        ]);

        let errorMessage = "Feedback not found or already deleted";

        if (feedbackExists) {
            if (!isManager) {
                errorMessage = "You are not authorized to delete this feedback";
            } else if (!isAcknowledged) {
                errorMessage = "Employee has still not acknowledged the feedback";
            }
        }

        throw new ApiError(404, errorMessage);
    }
    res.status(200).json(
        new ApiResponse(200, {
            id: softDeletion._id,
            isDeleted: softDeletion.isDeleted,
            deletedAt: softDeletion.deletedAt,
            version: softDeletion.version
        }, "Feedback soft deleted successfully")
    );
});

const makeIsDeletedFalse = asyncHandler(async (req, res) => {
    const manager = req.user;
    const { feedbackId } = req.params;

    if (!feedbackId || !mongoose.isValidObjectId(feedbackId)) {
        throw new ApiError(402, "Invalid format of the feedbackId");
    }
    if (manager.role !== "manager") {
        throw new ApiError(402, "Only managers can make it");
    }

    const existingFeedback = await Feedback.findOne(
        {
            _id: feedbackId,
            fromManagerId: manager._id,
            isDeleted: true
        }
    )

    if (!existingFeedback) {
        throw new ApiError(402, "Feedback not found eithere you are not the manager for that feedback or isDeleted is false")
    }
    const updatedFeedback = await Feedback.findByIdAndUpdate(feedbackId,
        {
            $set: {
                isDeleted: false,
            },
            $inc: { version: 1 }
        },
        {
            new: true,
            runValidators: true
        }
    )
    if (!updatedFeedback) {
        throw new ApiError(404, "Feedback not found");
    }

    res.status(200).json(new ApiResponse(200, updatedFeedback, "successfully removed soft deletion for the feedback"));
})

const acknowledgeFeedback = asyncHandler(async (req, res) => {
    const employeeUser = req.user;
    const { feedbackId } = req.params;

    if (!feedbackId || !mongoose.isValidObjectId(feedbackId)) {
        throw new ApiError(400, "Invalid feedback Id format");
    }
    if (!employeeUser.role === "employee") {
        throw new ApiError(404, "Only employee can Acknowledge it ");
    }
    const existingFeedback = await Feedback.findOne(
        {
            _id: feedbackId,
            toEmployeeId: employeeUser._id,
            isAcknowledged: false
        }
    )
    if (!existingFeedback) {
        throw new ApiError(404, "feedback not found or the you are not the employee for that feedback or may be isAcknowledge is true for this feedback");
    }

    const acknowledgedFeedback = await Feedback.findByIdAndUpdate(feedbackId,
        {
            $set: {
                isAcknowledged: true,
                acknowledgedAt: Date.now()
            },
            $inc: { version: 1 }
        },
        {
            new: true,
            runValidators: true
        }
    )
    if (!acknowledgedFeedback) {
        throw new ApiError(404, "Failed to acknowledge the feedback");
    }

    res.status(200).json(new ApiResponse(200, acknowledgedFeedback, "Successfully acknowledged the feedback"));
})

const getEmployeeFeedback = asyncHandler(async (req, res) => {
    const userEmployee = req.user;
    const {
        page = 1,
        limit = 10,
        sentiment,
        sortBy = 'createdAt',
        sortOrder = 'desc'
    } = req.query;

    if (userEmployee.role !== "employee") {
        throw new ApiError(403, "Only employees can access their feedback");
    }
    const pageNum = Math.max(1, parseInt(page));
    const limitNum = Math.min(50, Math.max(1, parseInt(limit)));
    const skip = (pageNum - 1) * limitNum;

    const validSortFields = ['createdAt', 'updatedAt', 'sentiment', 'acknowledgedAt'];
    const validSortOrders = ['asc', 'desc'];
    const sortField = validSortFields.includes(sortBy) ? sortBy : 'createdAt';
    const sortDirection = validSortOrders.includes(sortOrder) ? sortOrder : 'desc';

    const matchConditions = {
        toEmployeeId: userEmployee._id,
        isDeleted: false,
        isAcknowledged: true
    };

    if (sentiment && ["positive", "negative", "neutral"].includes(sentiment)) {
        matchConditions.sentiment = sentiment;
    }

    try {
        const [feedbackResult, totalCount] = await Promise.all([
            Feedback.aggregate([
                {
                    $match: matchConditions
                },
                {
                    $sort: { [sortField]: sortDirection === 'desc' ? -1 : 1 }
                },
                {
                    $skip: skip
                },
                {
                    $limit: limitNum
                },
                {
                    $lookup: {
                        from: "users",
                        localField: "fromManagerId",
                        foreignField: "_id",
                        as: "managerInfo",
                        pipeline: [
                            {
                                $project: {
                                    name: 1,
                                    email: 1,
                                    role: 1,
                                    isActive: 1,
                                    userProfile: 1,
                                }
                            }
                        ]
                    }
                },
                {
                    $addFields: {
                        manager: {
                            $arrayElemAt: ["$managerInfo", 0]
                        }
                    }
                },
                {
                    $project: {
                        manager: 1,
                        strengths: 1,
                        areasToImprove: 1,
                        sentiment: 1,
                        isAcknowledged: 1,
                        acknowledgedAt: 1,
                        createdAt: 1,
                        updatedAt: 1,
                        version: 1
                    }
                }
            ]),

            Feedback.countDocuments(matchConditions)

        ]);
        const totalPages = Math.ceil(totalCount / limitNum);
        const hasNextPage = pageNum < totalPages;
        const hasPrevPage = pageNum > 1;
        const paginationMeta = {
            currentPage: pageNum,
            totalPages,
            totalCount,
            limit: limitNum,
            hasNextPage,
            hasPrevPage,
            nextPage: hasNextPage ? pageNum + 1 : null,
            prevPage: hasPrevPage ? pageNum - 1 : null
        };

        if (!feedbackResult || feedbackResult.length === 0) {
            res.status(200).json(new ApiResponse(200, {
                feedback: [],
                pagination: paginationMeta,
                filters: { sentiment, sortBy: sortField, sortOrder: sortDirection }
            },
                "No acknowledged feedback found"
            ))
        }

        res.status(200).json(new ApiResponse(200, {
            feedback: feedbackResult,
            pagination: paginationMeta,
            filters: { sentiment, sortBy: sortField, sortOrder: sortDirection }
        },
            `Successfully retrieved ${feedbackResult.length} feedback record(s)`
        ));

    } catch (error) {
        console.error('Error fetching employee feedback:', error);
        throw new ApiError(500, "Failed to retrieve feedback. Please try again later.");
    }
})

const getManagerFeedback = asyncHandler(async (req, res) => {
    const manager = req.user;
    const {
        page = 1,
        limit = 10,
        sentiment,
        sortBy = 'createdAt',
        sortOrder = 'desc'
    } = req.query;
    if (manager.role !== "manager") {
        throw new ApiError(403, "Only managers can access this");
    }
    const pageNum = Math.max(1, parseInt(page));
    const limitNum = Math.min(50, Math.max(1, parseInt(limit)));
    const skip = (pageNum - 1) * limitNum;

    const validSortFields = ['createdAt', 'updatedAt', 'sentiment', 'acknowledgedAt'];
    const validSortOrders = ['asc', 'desc'];
    const sortField = validSortFields.includes(sortBy) ? sortBy : 'createdAt';
    const sortDirection = validSortOrders.includes(sortOrder) ? sortOrder : 'desc';

    const matchConditions = {
        fromManagerId: manager._id,
        isDeleted: false,
    }
    if (sentiment && ['positive', 'neutral', 'negative'].includes(sentiment)) {
        matchConditions.sentiment = sentiment;
    }

    try {
        const [feedbackResult, totalCount] = await Promise.all([
            Feedback.aggregate([
                {
                    $match: matchConditions,
                },
                {
                    $sort: { [sortField]: sortDirection === 'desc' ? -1 : 1 }
                },
                {
                    $skip: skip
                },
                {
                    $limit: limitNum
                },
                {
                    $lookup : {
                        from : "users",
                        localField : "toEmployeeId",
                        foreignField : "_id",
                        as : "employeeInfo",
                        pipeline : [
                            {
                                $project : {
                                    name : 1,
                                    email : 1,
                                    isActive : 1,
                                    userProfile : 1,
                                }
                            }
                        ]
                    }
                },
                {
                    $addFields : {
                        employee : {
                            $arrayElemAt : ["$employeeInfo" , 0]
                        }
                    }
                },
                {
                    $project : {
                        employee : 1,
                        strengths: 1,
                        areasToImprove: 1,
                        sentiment: 1,
                        isAcknowledged: 1,
                        acknowledgedAt: 1,
                        createdAt: 1,
                        updatedAt: 1,
                        version: 1
                    }
                }
            ]),
               Feedback.countDocuments(matchConditions)
        ])
        const totalPages = Math.ceil(totalCount / limitNum);
        const hasNextPage = pageNum < totalPages;
        const hasPrevPage = pageNum > 1;

        const paginationMeta = {
            currentPage: pageNum,
            totalPages,
            totalCount,
            limit: limitNum,
            hasNextPage,
            hasPrevPage,
            nextPage: hasNextPage ? pageNum + 1 : null,
            prevPage: hasPrevPage ? pageNum - 1 : null
        };
        if(!feedbackResult || feedbackResult.length === 0){
            return res.status(200).json(new ApiResponse(200 , 
                {
                    feedback : [],
                    pagination : paginationMeta,
                    filters: { sentiment, sortBy: sortField, sortOrder: sortDirection }
                },
                 "No feedback found"
            ))
        }

        res.status(200).json(new ApiResponse(200 , {
            feedback : feedbackResult,
            pagination : paginationMeta,
            filters: { sentiment, sortBy: sortField, sortOrder: sortDirection }
        },
        `Successfully retrieved ${feedbackResult.length} feedback record(s)`
    ))
    } catch (error) {
        console.error('Error fetching employee feedback:', error);
        throw new ApiError(500, "Failed to retrieve feedback. Please try again later.");
    }
});

export { createFeedback, getFeedbackById, updateFeedback, softDeleteFeedback, makeIsDeletedFalse, acknowledgeFeedback, getEmployeeFeedback , getManagerFeedback }; 