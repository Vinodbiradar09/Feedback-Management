import { asyncHandler } from "../utils/asyncHandler.js";
import { ApiError } from "../utils/ApiError.js";
import { ApiResponse } from "../utils/ApiResponse.js";
import { User } from "../models/users.model.js";
import { Team } from "../models/teams.model.js";
import { Feedback } from "../models/feedback.model.js";
import { Feedbackhistory } from "../models/feedbackHistory.model.js";
import mongoose, { version } from "mongoose";
import PDFDocument from "pdfkit";
import getStream from 'get-stream';
import { generateEmployeeFeedbackPDF} from "../utils/generatePdf.js";
import { getEmailTransporter , testEmailConfiguration } from "../utils/sendEmail.js";

const exportRateLimit = new Map();
const RATE_LIMIT_WINDOW = 60 * 60 * 1000; // 1 hour
const MAX_EXPORTS_PER_HOUR = 5;

const checkRateLimit = (userId) => {
    try {
        if (!userId) {
            console.error('checkRateLimit called without userId');
            return false;
        }

        const now = Date.now();
        const userKey = userId.toString();

        if (!exportRateLimit.has(userKey)) {
            exportRateLimit.set(userKey, { count: 1, resetTime: now + RATE_LIMIT_WINDOW });
            return true;
        }

        const userLimit = exportRateLimit.get(userKey);
        if (now > userLimit.resetTime) {
            exportRateLimit.set(userKey, { count: 1, resetTime: now + RATE_LIMIT_WINDOW });
            return true;
        }
        if (userLimit.count >= MAX_EXPORTS_PER_HOUR) {
            return false;
        }
        userLimit.count += 1;
        return true;

    } catch (error) {
        console.error('Error in checkRateLimit:', error);
        return false; 
    }
};

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
                    $lookup: {
                        from: "users",
                        localField: "toEmployeeId",
                        foreignField: "_id",
                        as: "employeeInfo",
                        pipeline: [
                            {
                                $project: {
                                    name: 1,
                                    email: 1,
                                    isActive: 1,
                                    userProfile: 1,
                                }
                            }
                        ]
                    }
                },
                {
                    $addFields: {
                        employee: {
                            $arrayElemAt: ["$employeeInfo", 0]
                        }
                    }
                },
                {
                    $project: {
                        employee: 1,
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
        if (!feedbackResult || feedbackResult.length === 0) {
            return res.status(200).json(new ApiResponse(200,
                {
                    feedback: [],
                    pagination: paginationMeta,
                    filters: { sentiment, sortBy: sortField, sortOrder: sortDirection }
                },
                "No feedback found"
            ))
        }

        res.status(200).json(new ApiResponse(200, {
            feedback: feedbackResult,
            pagination: paginationMeta,
            filters: { sentiment, sortBy: sortField, sortOrder: sortDirection }
        },
            `Successfully retrieved ${feedbackResult.length} feedback record(s)`
        ))
    } catch (error) {
        console.error('Error fetching employee feedback:', error);
        throw new ApiError(500, "Failed to retrieve feedback. Please try again later.");
    }
});

const bulkCreateFeedback = asyncHandler(async (req, res) => {
    const manager = req.user
    const { feedbacks } = req.body;
    if (manager.role !== "manager") {
        throw new ApiError(403, "Only managers can create feedback");
    }
    if (!feedbacks || !Array.isArray(feedbacks) || feedbacks.length === 0) {
        throw new ApiError(400, "Feedbacks array is required and must not be empty");
    }
    const MAX_BATCH_SIZE = 100;
    if (feedbacks.length > MAX_BATCH_SIZE) {
        throw new ApiError(400, `Cannot create more than ${MAX_BATCH_SIZE} feedbacks at once`);
    }
    const validatedFeedbacks = [];
    const validationErrors = [];
    const employeeIds = new Set();

    for (let i = 0; i < feedbacks.length; i++) {
        const feedback = feedbacks[i];
        const errors = [];

        if (!feedback.toEmployeeId || !mongoose.isValidObjectId(feedback.toEmployeeId)) {
            errors.push(`Invalid employee ID at index ${i}`);
        } else {
            employeeIds.add(feedback.toEmployeeId.toString());
        }

        if (!feedback.strengths || typeof feedback.strengths !== "string" || feedback.strengths.trim().length === 0) {
            errors.push(`Strengths is required and must be a non-empty string at index ${i}`);
        } else if (feedback.strengths.trim().length > 1000) {
            errors.push(`Strengths cannot exceed 1000 characters at index ${i}`);
        }

        if (!feedback.areasToImprove || typeof feedback.areasToImprove !== "string" || feedback.areasToImprove.trim().length === 0) {
            errors.push(`Areas to improve is required and must be a non-empty string at index ${i}`);
        } else if (feedback.areasToImprove.trim().length > 1000) {
            errors.push(`Areas to improve cannot exceed 1000 characters at index ${i}`);
        }

        if (!feedback.sentiment || !["positive", "neutral", "negative"].includes(feedback.sentiment)) {
            errors.push(`Sentiment must be positive, neutral, or negative at index ${i}`);
        }

        if (errors.length > 0) {
            validationErrors.push(...errors);
        } else {
            validatedFeedbacks.push({
                fromManagerId: manager._id,
                toEmployeeId: new mongoose.Types.ObjectId(feedback.toEmployeeId),
                strengths: feedback.strengths,
                areasToImprove: feedback.areasToImprove,
                sentiment: feedback.sentiment,
                isAcknowledged: false,
                acknowledgedAt: null,
                version: 1,
                isDeleted: false
            })
        }
    }

    if (validationErrors.length > 0) {
        throw new ApiError(400, `Validation errors: ${validationErrors.join(', ')}`);
    }
    if (employeeIds.size !== feedbacks.length) {
        throw new ApiError(400, "Duplicate employee IDs found in the batch");
    }
    const session = await mongoose.startSession();
    try {
        const result = await session.withTransaction(async () => {
            const employees = await User.find({
                _id: { $in: Array.from(employeeIds).map(id => new mongoose.Types.ObjectId(id)) },
                role: "employee",
                isActive: true
            }).select("_id name email userProfile").session(session);

            if (employees.length !== employeeIds.size) {
                const foundEmployeeIds = new Set(employees.map(emp => emp._id.toString()));
                const missingIds = Array.from(employeeIds).filter(id => !foundEmployeeIds.has(id));
                throw new ApiError(400, `Invalid or inactive employee IDs: ${missingIds.join(', ')}`);
            }

            const teamCheck = await Team.findOne({
                managerId: manager._id,
                employeeIds: { $all: Array.from(employeeIds).map(id => new mongoose.Types.ObjectId(id)) },
                isActive: true,

            }).session(session);
            if (!teamCheck) {
                throw new ApiError(403, "You don't have permission to give feedback to one or more of these employees");
            }

            const existingFeedback = await Feedback.find({
                fromManagerId: manager._id,
                toEmployeeId: { $in: Array.from(employeeIds).map(id => new mongoose.Types.ObjectId(id)) },
                isDeleted: false,
                createdAt: {
                    $gte: new Date(Date.now() - 24 * 60 * 60 * 1000) // Last 24 hours
                }
            }).select('toEmployeeId').session(session)
            if (existingFeedback.length > 0) {
                const recentEmployeeIds = existingFeedback.map(f => f.toEmployeeId.toString());
                throw new ApiError(409, `Feedback already exists for employees in the last 24 hours: ${recentEmployeeIds.join(', ')}`);
            }

            const createdFeedbacks = await Feedback.insertMany(validatedFeedbacks,
                {
                    session,
                    ordered: false
                });

            return {
                createdFeedbacks,
                employees: employees.reduce((acc, emp) => {
                    acc[emp._id.toString()] = { name: emp.name, email: emp.email };
                    return acc;
                }, {})
            };
        });

        const responseData = {
            success: true,
            totalCreated: result.createdFeedbacks.length,
            feedbacks: result.createdFeedbacks.map(feedback => ({
                _id: feedback._id,
                employee: result.employees[feedback.toEmployeeId.toString()],
                strengths: feedback.strengths,
                areasToImprove: feedback.areasToImprove,
                sentiment: feedback.sentiment,
                createdAt: feedback.createdAt
            }))

        };
        res.status(201).json(
            new ApiResponse(201, responseData, `Successfully created ${result.createdFeedbacks.length} feedback records`)
        );
    } catch (error) {
        if (error instanceof ApiError) {
            throw error;
        }
        if (error.code === 11000) {
            throw new ApiError(409, "Duplicate feedback entry detected");
        }

        console.error('Bulk feedback creation error:', error);
        throw new ApiError(500, "Failed to create feedback records");
    } finally {
        await session.endSession();
    }
});

const exportEmployeeFeedback = asyncHandler(async (req, res) => {
    const MAX_EXPORTS_PER_HOUR = 5;
    const employee = req.user;
    const { includeManagerDetails = false, dateRange } = req.query;
    if (employee.role !== 'employee') {
        throw new ApiError(403, 'Only employees can export their feedback');
    }
    if (!checkRateLimit(employee._id)) {
        throw new ApiError(429, `Rate limit exceeded. You can only export ${MAX_EXPORTS_PER_HOUR} reports per hour`);
    }
    const query = {
        toEmployeeId: employee._id,
        isAcknowledged: true,
        isDeleted: false,
    };

    if (dateRange) {
        const { startDate, endDate } = dateRange;
        if (startDate || endDate) {
            query.acknowledgedAt = {};
            if (startDate) query.acknowledgedAt.$gte = new Date(startDate);
            if (endDate) query.acknowledgedAt.$lte = new Date(endDate);
        }
    }

    try {
      
        let feedbackQuery = Feedback.find(query)
            .select('strengths areasToImprove sentiment fromManagerId acknowledgedAt createdAt')
            .sort({ acknowledgedAt: -1 })
            .lean();

      
        if (includeManagerDetails === 'true' || includeManagerDetails === true) {
            feedbackQuery = feedbackQuery.populate({
                path: 'fromManagerId',
                select: 'name email',
                options: { lean: true }
            });
        }

        console.log('Executing feedback query for user:', employee._id);
        const feedbacks = await feedbackQuery;

        if (!feedbacks || feedbacks.length === 0) {
            throw new ApiError(404, 'No acknowledged feedback records found to export');
        }

        console.log(`Found ${feedbacks.length} feedback records`);

      
        const MAX_FEEDBACK_RECORDS = 100;
        const limitedFeedbacks = feedbacks.slice(0, MAX_FEEDBACK_RECORDS);

        if (feedbacks.length > MAX_FEEDBACK_RECORDS) {
            console.warn(`User ${employee._id} attempted to export ${feedbacks.length} records, limited to ${MAX_FEEDBACK_RECORDS}`);
        }
        console.log('Generating PDF and setting up email transporter...');
        
        let pdfBuffer;
        let transporter;
        
        try {
           
            pdfBuffer = await generateEmployeeFeedbackPDF(limitedFeedbacks, employee.name, employee.email);
            console.log('PDF generated successfully, buffer size:', pdfBuffer?.length);
        } catch (pdfError) {
            console.error('PDF generation error:', pdfError);
            throw new ApiError(500, 'Failed to generate PDF report');
        }

        try {
          
            transporter = getEmailTransporter();
            console.log('Email transporter obtained');
        } catch (emailError) {
            console.error('Email transporter error:', emailError);
            throw new ApiError(500, 'Failed to initialize email service');
        }
        const emailOptions = {
            from: `"Feedback System" <${process.env.SMTP_EMAIL}>`,
            to: employee.email,
            subject: `Your Feedback Report - ${new Date().toLocaleDateString()}`,
            html: `
                <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
                    <h2 style="color: #2c3e50;">Your Feedback Report</h2>
                    <p>Dear ${employee.name || 'Employee'},</p>
                    <p>Please find your comprehensive feedback report attached as a PDF document.</p>
                    <div style="background-color: #f8f9fa; padding: 15px; border-radius: 5px; margin: 20px 0;">
                        <h3 style="margin: 0; color: #495057;">Report Summary:</h3>
                        <ul style="margin: 10px 0;">
                            <li>Total Feedback Records: <strong>${limitedFeedbacks.length}</strong></li>
                            <li>Date Range: <strong>${limitedFeedbacks.length > 0 ? new Date(limitedFeedbacks[limitedFeedbacks.length - 1].acknowledgedAt).toLocaleDateString() + ' - ' + new Date(limitedFeedbacks[0].acknowledgedAt).toLocaleDateString() : 'N/A'}</strong></li>
                            <li>Generated: <strong>${new Date().toLocaleString()}</strong></li>
                        </ul>
                    </div>
                    <p style="color: #6c757d; font-size: 12px;">
                        This report is confidential and intended only for the recipient. 
                        Please contact HR if you have any questions about your feedback.
                    </p>
                </div>
            `,
            attachments: [
                {
                    filename: `feedback_report_${(employee.name || 'employee').replace(/\s+/g, '_')}_${new Date().toISOString().split('T')[0]}.pdf`,
                    content: pdfBuffer,
                    contentType: 'application/pdf'
                }
            ]
        };
        let emailSent = false;
        let retryCount = 0;
        const maxRetries = 3;

        while (!emailSent && retryCount < maxRetries) {
            try {
                console.log(`Sending email attempt ${retryCount + 1}...`);
                await transporter.sendMail(emailOptions);
                emailSent = true;
                console.log('Email sent successfully');
            } catch (emailError) {
                retryCount++;
                console.error(`Email send attempt ${retryCount} failed:`, {
                    error: emailError.message,
                    code: emailError.code,
                    command: emailError.command
                });
                
                if (retryCount >= maxRetries) {
                    throw new ApiError(500, 'Failed to send email after multiple attempts. Please try again later.');
                }
                const delay = Math.pow(2, retryCount) * 1000;
                console.log(`Waiting ${delay}ms before retry...`);
                await new Promise(resolve => setTimeout(resolve, delay));
            }
        }
        const userRateLimit = exportRateLimit.get(employee._id.toString());
        const remainingExports = Math.max(0, MAX_EXPORTS_PER_HOUR - (userRateLimit?.count || 0));
        res.status(200).json(
            new ApiResponse(200, {
                success: true,
                recordsExported: limitedFeedbacks.length,
                totalRecords: feedbacks.length,
                emailSent: employee.email,
                generatedAt: new Date().toISOString(),
                remainingExports: remainingExports
            }, `PDF report with ${limitedFeedbacks.length} feedback records has been successfully sent to ${employee.email}`)
        );

    } catch (error) {
        console.error('Export feedback error:', {
            userId: employee._id,
            email: employee.email,
            error: error.message,
            stack: error.stack,
            timestamp: new Date().toISOString()
        });
        if (error instanceof ApiError) {
            throw error;
        }
        if (error.name === 'ValidationError') {
            throw new ApiError(400, 'Invalid data provided for feedback export');
        }
        
        if (error.name === 'CastError') {
            throw new ApiError(400, 'Invalid ID format provided');
        }
        throw new ApiError(500, 'Failed to generate and send feedback report. Please try again later.');
    }
});

export { createFeedback, getFeedbackById, updateFeedback, softDeleteFeedback, makeIsDeletedFalse, acknowledgeFeedback, getEmployeeFeedback, getManagerFeedback, bulkCreateFeedback , exportEmployeeFeedback }; 