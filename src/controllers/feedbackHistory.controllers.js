import { asyncHandler } from "../utils/asyncHandler.js";
import { ApiError } from "../utils/ApiError.js";
import { ApiResponse } from "../utils/ApiResponse.js";
import { User } from "../models/users.model.js";
import { Team } from "../models/teams.model.js";
import { Feedback } from "../models/feedback.model.js";
import { Feedbackhistory } from "../models/feedbackHistory.model.js";
import mongoose from "mongoose";



const getFeedbackHistory = asyncHandler(async (req, res) => {
    const { _id: requesterId, role: requesterRole } = req.user;
    const { feedbackId } = req.params;

    if (!feedbackId || !mongoose.isValidObjectId(feedbackId)) {
        throw new ApiError(400, "Invalid feedback Id format , please check it");
    }

    if (!["admin", "manager", "employee"].includes(requesterRole)) {
        throw new ApiError(403, "Only Authorized Feedback system users can access it ");
    }
    const feedback = await Feedback.findById(feedbackId).lean();

    if (!feedback || feedback.isDeleted) {
        throw new ApiError(404, "Feedback not found or has been deleted");
    }

    if (requesterRole === "employee" && feedback.toEmployeeId.toString() !== requesterId.toString()) {
        throw new ApiError(403, "Employees can only access their own feedback history");
    }

    if (requesterRole === "manager" && feedback.fromManagerId.toString() !== requesterId.toString()) {
        throw new ApiError(403, "Managers can only access feedbacks they created");
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
                localField: "toEmployeeId",
                foreignField: "_id",
                as: "employeeDetails",
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
                employee: {
                    $arrayElemAt: ["$employeeDetails", 0],
                }
            }
        },
        {
            $lookup: {
                from: "feedbackhistories",
                localField: "_id",
                foreignField: "feedbackId",
                as: "feedbackHistoryInfo",
                pipeline: [
                    {
                        $lookup: {
                            from: "users",
                            localField: "editedByManagersId",
                            foreignField: "_id",
                            as: "editedManagerDetails",
                            pipeline: [
                                {
                                    $project: {
                                        name: 1,
                                        email: 1,
                                        role: 1,
                                        isActive: 1,
                                        userProfile: 1
                                    }
                                }
                            ]
                        }
                    },
                    {
                        $addFields: {
                            editedManager: {
                                $arrayElemAt: ["$editedManagerDetails", 0]
                            }
                        }
                    },
                    {
                        $project: {
                            previousData: 1,
                            editReason: 1,
                            editedAt: 1,
                            editedManager: 1
                        }
                    },
                    {
                        $sort: { editedAt: -1 }
                    }
                ]
            }
        },
        {
            $project: {
                strengths: 1,
                areasToImprove: 1,
                sentiment: 1,
                version: 1,
                isAcknowledged: 1,
                acknowledgedAt: 1,
                createdAt: 1,
                updatedAt: 1,
                employee: 1,
                feedbackHistoryInfo: 1
            }
        }
    ])

    if (!result || result.length === 0) {
        throw new ApiError(404, "feedback history not found");
    }
    res
        .status(200)
        .json(new ApiResponse(200, result[0], "Feedback history fetched successfully"));

})

const getFeedbackHistoryById = asyncHandler(async (req, res) => {

    const { feedbackHistoryId } = req.params;
    const { _id: requesterId, role: requesterRole } = req.user;

    if (!feedbackHistoryId || !mongoose.isValidObjectId(feedbackHistoryId)) {
        throw new ApiError(400, "Invalid feedback history ID format");
    }
    if (!["admin", "manager", "employee"].includes(requesterRole)) {
        throw new ApiError(403, "Only Authorized Feedback system users can access it ");
    }
    const result = await Feedbackhistory.aggregate([
        {
            $match: {
                _id: new mongoose.Types.ObjectId(feedbackHistoryId),
            }
        },
        {
            $lookup: {
                from: "feedbacks",
                localField: "feedbackId",
                foreignField: "_id",
                as: "feedbackInfo",
                pipeline: [
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
                                        role: 1,
                                        isActive: 1,
                                        userProfile: 1
                                    }
                                }
                            ]
                        }
                    },
                    {
                        $addFields: {
                            employee: {
                                $arrayElemAt: ["$employeeDetails", 0]
                            }
                        }
                    },
                    {
                        $project: {
                            toEmployeeId: 1,
                            createdBy: 1,
                            employee: 1,
                            isAcknowledged: 1,
                            acknowledgedAt: 1,
                            version: 1,
                            isDeleted: 1,
                        }
                    }
                ]
            }
        },
        {
            $unwind: "$feedbackInfo",
        },
        {
            $lookup: {
                from: "users",
                localField: "editedByManagersId",
                foreignField: "_id",
                as: "managersDetails",
                pipeline: [
                    {
                        $project: {
                            name: 1,
                            email: 1,
                            role: 1,
                            isActive: 1,
                            userProfile: 1
                        }
                    }
                ]
            }
        },
        {
            $addFields: {
                manager: {
                    $arrayElemAt: ["$managersDetails", 0],
                },
            },
        },
        {
            $project: {
                previousData: 1,
                editReason: 1,
                editedAt: 1,
                manager: 1,
                feedbackInfo: 1,
            }
        }
    ]);

    if (!result || result.length === 0) {
        throw new ApiError(404, "Feedback history not found");
    }

    const feedbackHistory = result[0];
    const { feedbackInfo } = feedbackHistory;

    if (requesterRole === "employee") {
        const isOwner = feedbackInfo.toEmployeeId.toString() === requesterId.toString();
        if (!isOwner) {
            throw new ApiError(403, "You can only access your own feedback history.");
        }
    }

    if (requesterRole === "manager") {
        const hasEdited = feedbackHistory.manager?._id?.toString() === requesterId.toString();
        if (!hasEdited) {
            throw new ApiError(403, "You can only access feedback history you've edited.");
        }

        const managerTeams = await Team.find(
            {
                managerId: requesterId,
                isActive: true,
            }
        ).select("employeeIds");

        const allEmployeeIds = managerTeams.flatMap(team => team.employeeIds.map(id => id.toString()));
        if (!allEmployeeIds.includes(feedbackInfo.toEmployeeId.toString())) {
            throw new ApiError(403, "You can only access feedback for your team members.");
        }
    }
    res.status(200).json(new ApiResponse(200, feedbackHistory, "successfully got the feedback history"));
})

const deleteFeedbackHistory = asyncHandler(async (req, res) => {
    const { feedbackHistoryId } = req.params;
    const { _id: requesterId, role: requesterRole } = req.user;

    if (!feedbackHistoryId || !mongoose.isValidObjectId(feedbackHistoryId)) {
        throw new ApiError(400, "Invalid feedbackHistoryId. Please provide a valid MongoDB ObjectId.");
    }
    if (requesterRole !== "admin") {
        throw new ApiError(403, "Access denied. Only admins can delete feedback history.");
    }
    const feedbackHistory = await Feedbackhistory.findById(feedbackHistoryId).lean();
    if (!feedbackHistory) {
        throw new ApiError(404, "Feedback history not found.");
    }
    const deletedResult = await Feedbackhistory.findByIdAndDelete(feedbackHistoryId);

    res.status(200).json(
        new ApiResponse(200, deletedResult, "Feedback history deleted successfully.")
    );
});

const getFeedbackHistoryByManager = asyncHandler(async (req, res) => {
    let managerId;

    if (req.user.role === "admin") {
        managerId = req.params.managerId;
        if (!managerId || !mongoose.isValidObjectId(managerId)) {
            throw new ApiError(400, "Invalid manager ID");
        }
    } else if (req.user.role === "manager") {
        managerId = req.user._id;
    } else {
        throw new ApiError(403, "You are not authorized to view this resource");
    }

    const result = await Feedbackhistory.aggregate([
        {
            $match: {
                editedByManagersId: new mongoose.Types.ObjectId(managerId),
            },
        },
        {
            $lookup: {
                from: "feedbacks",
                localField: "feedbackId",
                foreignField: "_id",
                as: "feedbackInfo",
                pipeline: [
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
                                        role: 1,
                                        isActive: 1,
                                        userProfile: 1,
                                    },
                                },
                            ],
                        },
                    },
                    {
                        $addFields: {
                            employee: { $arrayElemAt: ["$employeeDetails", 0] },
                        },
                    },
                    {
                        $project: {
                            strengths: 1,
                            areasToImprove: 1,
                            sentiment: 1,
                            isAcknowledged: 1,
                            acknowledgedAt: 1,
                            version: 1,
                            isDeleted: 1,
                            employee: 1,
                        },
                    },
                ],
            },
        },
        {
            $lookup: {
                from: "users",
                localField: "editedByManagersId",
                foreignField: "_id",
                as: "managerDetails",
                pipeline: [
                    {
                        $project: {
                            name: 1,
                            email: 1,
                            role: 1,
                            isActive: 1,
                            userProfile: 1,
                        },
                    },
                ],
            },
        },
        {
            $addFields: {
                manager: { $arrayElemAt: ["$managerDetails", 0] },
            },
        },
        {
            $project: {
                previousData: 1,
                editReason: 1,
                editedAt: 1,
                feedbackInfo: 1,
                manager: 1,
            },
        },
        {
            $sort: { editedAt: -1 }, // Optional sorting
        },
    ]);

    if (!result || result.length === 0) {
        throw new ApiError(404, "No feedback history found for this manager");
    }

    res
        .status(200)
        .json(new ApiResponse(200, result, "Successfully fetched feedback history by manager"));
});

const getFeedbackHistoryByDateRange = asyncHandler(async (req, res) => {
    const { startDate, endDate, employeeId } = req.query;
    const { _id: userId, role } = req.user;

    if (!startDate || !endDate) {
        throw new ApiError(400, "startDate and endDate are required");
    }
    const start = new Date(startDate);
    const end = new Date(endDate);
    end.setHours(23, 59, 59, 999);          // include full end‑day

    if (isNaN(start) || isNaN(end) || start > end) {
        throw new ApiError(400, "Invalid date range");
    }

    if (!["admin", "manager"].includes(role)) {
        throw new ApiError(403, "Only admins and managers can access feedback history");
    }
    let allowedEmployeeIds = null;

    if (role === "manager") {
        const team = await Team.findOne({
            managerId: userId,
            isActive: true
        }).select("employeeIds");

        if (!team) {
            throw new ApiError(403, "You don't manage any active team");
        }

        allowedEmployeeIds = team.employeeIds.map(id => id.toString());

        if (employeeId) {
            if (!mongoose.isValidObjectId(employeeId)) {
                throw new ApiError(400, "Invalid employeeId");
            }
            if (!allowedEmployeeIds.includes(employeeId)) {
                throw new ApiError(403, "Employee not in your team");
            }
        }
    }

    const history = await Feedbackhistory.aggregate([
        {
            $match: {
                editedAt: { $gte: start, $lte: end }
            }
        },
        {
            $lookup: {
                from: "feedbacks",
                localField: "feedbackId",
                foreignField: "_id",
                as: "feedback",
                pipeline: [
                    {
                        $project: {
                            toEmployeeId: 1,
                            strengths: 1,
                            areasToImprove: 1,
                            sentiment: 1,
                            isAcknowledged: 1
                        }
                    }
                ]
            }
        },
        {
            $unwind: "$feedback"
        }

    ])

    const employeeFilter = {};
    if (employeeId) {
        employeeFilter["feedback.toEmployeeId"] = new mongoose.Types.ObjectId(employeeId);
    } else if (allowedEmployeeIds) {
        employeeFilter["feedback.toEmployeeId"] = { $in: allowedEmployeeIds.map(id => new mongoose.Types.ObjectId(id)) };
    }
    if (Object.keys(employeeFilter).length) {
        history.push({ $match: employeeFilter });
    }

    history.push(
        {
            $project: {
                previousData: 1,
                editReason: 1,
                editedAt: 1,
                feedbackId: 1,
                "feedback.toEmployeeId": 1,
                "feedback.sentiment": 1,
                "feedback.isAcknowledged": 1
            }
        },
        { $sort: { editedAt: -1 } }
    );

    res
        .status(200)
        .json(new ApiResponse(200, history, "Feedback history fetched successfully"));

})

const bulkDeleteHistory = asyncHandler(async (req, res) => {
    const { _id: userId, role } = req.user;

    if (role !== "admin") {
        throw new ApiError(403, "Only admins are allowed to perform bulk delete.");
    }

    const { historyIds } = req.body;

    if (!Array.isArray(historyIds) || historyIds.length === 0) {
        throw new ApiError(400, "historyIds must be a non-empty array.");
    }

    const validIds = historyIds.filter((id) => mongoose.isValidObjectId(id));
    if (validIds.length === 0) {
        throw new ApiError(400, "No valid ObjectIds found in the request.");
    }

    const deleteResult = await Feedbackhistory.deleteMany({
        _id: { $in: validIds },
    });

    res.status(200).json(
        new ApiResponse(200, {
            deletedCount: deleteResult.deletedCount,
            attempted: validIds.length,
            invalidIds: historyIds.length - validIds.length,
        }, "Selected feedback history records deleted successfully.")
    );
})

export { getFeedbackHistory, getFeedbackHistoryById, deleteFeedbackHistory, getFeedbackHistoryByManager, getFeedbackHistoryByDateRange, bulkDeleteHistory };