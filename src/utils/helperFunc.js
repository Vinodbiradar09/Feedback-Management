import { asyncHandler } from "./asyncHandler.js";
import { ApiError } from "./ApiError.js";
import { ApiResponse } from "./ApiResponse.js";
import { User } from "../models/users.model.js";
import { Feedback } from "../models/feedback.model.js";
import { Team } from "../models/teams.model.js";
import mongoose from "mongoose";



async function buildAccessControlAndFilters({
    requesterId,
    requesterRole,
    employeeId,
    teamId,
    managerId,
    startDate,
    endDate,
    sentiment,
    acknowledged
}) {
    let baseMatchStage = {
        isDeleted: false
    };
    let accessScope = {};

  
    switch (requesterRole) {
        case 'admin':
            accessScope = { type: 'admin', description: 'Full access to all feedback data' };
            break;
            
        case 'manager':
           
            const managerTeams = await Team.find({ 
                managerId: requesterId, 
                isActive: true 
            }).select('employeeIds teamName').lean();
            
            if (!managerTeams || managerTeams.length === 0) {
                throw new ApiError(404, "No teams found for this manager");
            }
            
            const managerEmployeeIds = managerTeams.flatMap(team => team.employeeIds);
            baseMatchStage.toEmployeeId = { $in: managerEmployeeIds };
            
            accessScope = {
                type: 'manager',
                description: `Access to ${managerEmployeeIds.length} team members across ${managerTeams.length} teams`
            };
            break;
            
        default:
            throw new ApiError(403, "Access denied. Only administrators and managers can view feedback statistics");
    }

  
    if (employeeId) {
      
        if (requesterRole === 'manager') {
            const managerTeams = await Team.find({ 
                managerId: requesterId, 
                isActive: true 
            }).select('employeeIds').lean();
            
            const managerEmployeeIds = managerTeams.flatMap(team => 
                team.employeeIds.map(id => id.toString())
            );
            
            if (!managerEmployeeIds.includes(employeeId)) {
                throw new ApiError(403, "You can only view feedback for your team members");
            }
        }
        baseMatchStage.toEmployeeId = new mongoose.Types.ObjectId(employeeId);
    }

    if (managerId) {
        baseMatchStage.fromManagerId = new mongoose.Types.ObjectId(managerId);
    }

    if (startDate || endDate) {
        baseMatchStage.createdAt = {};
        if (startDate) {
            baseMatchStage.createdAt.$gte = new Date(startDate);
        }
        if (endDate) {
            baseMatchStage.createdAt.$lte = new Date(endDate);
        }
    }

    if (sentiment) {
        baseMatchStage.sentiment = sentiment;
    }

    if (acknowledged !== undefined) {
        baseMatchStage.isAcknowledged = acknowledged === 'true';
    }

   
    if (teamId) {
        const team = await Team.findOne({ 
            _id: teamId, 
            isActive: true 
        }).select('employeeIds managerId').lean();
        
        if (!team) {
            throw new ApiError(404, "Team not found or inactive");
        }
        
       
        if (requesterRole === 'manager' && team.managerId.toString() !== requesterId.toString()) {
            throw new ApiError(403, "You can only view feedback for your own team");
        }
        
     
        if (baseMatchStage.toEmployeeId && baseMatchStage.toEmployeeId.$in) {
            
            const existingIds = baseMatchStage.toEmployeeId.$in.map(id => id.toString());
            const teamEmployeeIds = team.employeeIds.map(id => id.toString());
            const intersectedIds = existingIds.filter(id => teamEmployeeIds.includes(id));
            
            if (intersectedIds.length === 0) {
                throw new ApiError(404, "No employees found in the specified team matching your access scope");
            }
            
            baseMatchStage.toEmployeeId = { 
                $in: intersectedIds.map(id => new mongoose.Types.ObjectId(id))
            };
        } else if (baseMatchStage.toEmployeeId && !baseMatchStage.toEmployeeId.$in) {
           
            const singleEmployeeId = baseMatchStage.toEmployeeId.toString();
            const teamEmployeeIds = team.employeeIds.map(id => id.toString());
            
            if (!teamEmployeeIds.includes(singleEmployeeId)) {
                throw new ApiError(404, "Specified employee is not in the selected team");
            }
           
        } else {
           
            baseMatchStage.toEmployeeId = { $in: team.employeeIds };
        }
    }

    return { baseMatchStage, accessScope };
}

async function generateFeedbackStatistics(baseMatchStage, sortBy, page, limit) {
    const skip = (parseInt(page) - 1) * parseInt(limit);
    let sortStage = {};

    switch (sortBy) {
        case 'recent':
            sortStage = { createdAt: -1 };
            break;
        case 'oldest':
            sortStage = { createdAt: 1 };
            break;
        case 'sentiment':
            sortStage = { sentiment: 1, createdAt: -1 };
            break;
        case 'acknowledged':
            sortStage = { isAcknowledged: -1, createdAt: -1 };
            break;
        default:
            sortStage = { createdAt: -1 };
    }

    const pipeline = [
        { $match: baseMatchStage },
        {
            $lookup: {
                from: "users",
                localField: 'toEmployeeId',
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
                from: "teams",
                localField: "toEmployeeId",
                foreignField: "employeeIds",
                as: "teamInfo",
                pipeline: [
                    {
                        $project: {
                            teamName: 1,
                            managerId: 1
                        }
                    }
                ]
            }
        },
        {
            $addFields: {
                employee: {
                    $arrayElemAt: ["$employeeDetails", 0],
                },
                manager: {
                    $arrayElemAt: ["$managerDetails", 0],
                },
                team: {
                    $arrayElemAt: ["$teamInfo", 0],
                },
                feedbackAge: {
                    $divide: [
                        { $subtract: [new Date(), '$createdAt'] },
                        86400000 // Convert to days
                    ]
                },
                responseTime: {
                    $cond: [
                        '$isAcknowledged',
                        {
                            $divide: [
                                { $subtract: ['$acknowledgedAt', '$createdAt'] },
                                86400000
                            ]
                        },
                        null
                    ]
                }
            }
        },
        {
            $project: {
                _id: 1,
                strengths: 1,
                areasToImprove: 1,
                sentiment: 1,
                isAcknowledged: 1,
                acknowledgedAt: 1,
                feedbackAge: { $round: ['$feedbackAge', 1] },
                responseTime: {
                    $cond: [
                        '$responseTime',
                        { $round: ['$responseTime', 1] },
                        null
                    ]
                },
                employee: {
                    _id: "$employee._id",
                    name: "$employee.name",
                    email: "$employee.email",
                    userProfile: "$employee.userProfile",
                    role: "$employee.role",
                },
                manager: {
                    _id: "$manager._id",
                    name: "$manager.name",
                    email: "$manager.email",
                    userProfile: "$manager.userProfile",
                    role: "$manager.role",
                },
                team: {
                    _id: '$team._id',
                    teamName: '$team.teamName'
                },
                createdAt: 1,
                updatedAt: 1,
                version: 1
            }
        },
        {
            $facet: {
                data: [
                    { $sort: sortStage },
                    { $skip: skip },
                    { $limit: parseInt(limit) }
                ],
                summary: [
                    {
                        $group: {
                            _id: null,
                            totalCount: { $sum: 1 },
                            sentimentBreakdown: {
                                $push: "$sentiment"
                            },
                            acknowledgedCount: {
                                $sum: { $cond: ['$isAcknowledged', 1, 0] }
                            },
                            averageResponseTime: {
                                $avg: '$responseTime'
                            }
                        }
                    },
                    {
                        $addFields: {
                            sentimentStats: {
                                positive: {
                                    $size: {
                                        $filter: {
                                            input: "$sentimentBreakdown",
                                            cond: { $eq: ["$$this", 'positive'] }
                                        }
                                    }
                                },
                                neutral: {
                                    $size: {
                                        $filter: {
                                            input: '$sentimentBreakdown',
                                            cond: { $eq: ['$$this', 'neutral'] }
                                        }
                                    }
                                },
                                negative: {
                                    $size: {
                                        $filter: {
                                            input: '$sentimentBreakdown',
                                            cond: { $eq: ['$$this', 'negative'] }
                                        }
                                    }
                                }
                            },
                            acknowledgmentRate: {
                                $cond: [
                                    { $gt: ['$totalCount', 0] },
                                    { $multiply: [{ $divide: ['$acknowledgedCount', '$totalCount'] }, 100] },
                                    0
                                ]
                            }
                        }
                    }
                ]
            }
        }
    ];

    const [result] = await Feedback.aggregate(pipeline);

    const summary = result.summary[0] || {
        totalCount: 0,
        sentimentStats: { positive: 0, neutral: 0, negative: 0 },
        acknowledgedCount: 0,
        acknowledgmentRate: 0,
        averageResponseTime: null
    };

    return {
        feedbackItems: result.data,
        totalCount: summary.totalCount,
        sentimentDistribution: summary.sentimentStats,
        acknowledgmentStats: {
            acknowledgedCount: summary.acknowledgedCount,
            pendingCount: summary.totalCount - summary.acknowledgedCount,
            acknowledgmentRate: Math.round(summary.acknowledgmentRate * 100) / 100
        },
        averageResponseTime: summary.averageResponseTime ?
            Math.round(summary.averageResponseTime * 10) / 10 : null
    }
}

async function generateFeedbackTrends(baseMatchStage) {
    const pipeline = [
        { $match: baseMatchStage },

        {
            $group: {
                _id: {
                    year: { $year: '$createdAt' },
                    month: { $month: '$createdAt' },
                    sentiment: '$sentiment'
                },
                count: { $sum: 1 },
                acknowledgedCount: { $sum: { $cond: ['$isAcknowledged', 1, 0] } }
            }
        },

        {
            $group: {
                _id: {
                    year: '$_id.year',
                    month: '$_id.month'
                },
                totalFeedback: { $sum: '$count' },
                sentimentBreakdown: {
                    $push: {
                        sentiment: '$_id.sentiment',
                        count: '$count',
                        acknowledgedCount: '$acknowledgedCount'
                    }
                }
            }
        },

        { $sort: { '_id.year': -1, '_id.month': -1 } },

        { $limit: 12 },

        {
            $project: {
                _id: 0,
                period: {
                    $concat: [
                        { $toString: '$_id.year' },
                        '-',
                        {
                            $cond: [
                                { $lt: ['$_id.month', 10] },
                                { $concat: ['0', { $toString: '$_id.month' }] },
                                { $toString: '$_id.month' }
                            ]
                        }
                    ]
                },
                totalFeedback: 1,
                sentimentBreakdown: 1
            }
        }
    ];
    const trends = await Feedback.aggregate(pipeline);

    return {
        monthlyTrends: trends,
        trendsGenerated: new Date().toISOString()
    }
}
export { buildAccessControlAndFilters, generateFeedbackStatistics, generateFeedbackTrends };