import { asyncHandler } from "./asyncHandler.js";
import { ApiError } from "./ApiError.js";
import { ApiResponse } from "./ApiResponse.js";
import { User } from "../models/users.model.js";
import { Team } from "../models/teams.model.js";
import { Feedback } from "../models/feedback.model.js";
import { Feedbackhistory } from "../models/feedbackHistory.model.js";
import mongoose from "mongoose";


const RECENT_ACTIVITY_LIMIT = 20;
const TOP_EMPLOYEES_LIMIT = 10;
const DAILY_TREND_DAYS = 30;

const CONFIG = {
    RECENT_FEEDBACK_LIMIT: 15,
    FEEDBACK_HISTORY_DAYS: 90,
    PERFORMANCE_TREND_MONTHS: 6,
    CACHE_TTL: 180,
    MAX_TIME_RANGE_DAYS: 365,
    DEFAULT_TIME_RANGE: 30
};

async function getManagerTeams(managerId) {
    const teams = await Team.aggregate([
        {
            $match: {
                managerId: new mongoose.Types.ObjectId(managerId),
                isActive: true,
            }
        },
        {
            $lookup: {
                from: "users",
                localField: "employeeIds",
                foreignField: "_id",
                as: "employees",
                pipeline: [
                    {
                        $match: {
                            isActive: true,
                            role: 'employee'
                        }
                    },
                    {
                        $project: {
                            name: 1,
                            email: 1,
                            userProfile: 1,
                            lastLogin: 1,
                        }
                    }
                ]
            }
        },
        {
            $addFields: {
                activeEmployeeCount: {
                    $size: {
                        $ifNull: ["$employees", []]
                    }
                },
                recentlyActiveCount: {
                    $size: {
                        $filter: {
                            input: {
                                $ifNull: ["$employees", []]
                            },
                            cond: {
                                $gte: [
                                    "$$this.lastLogin",
                                    { $subtract: [new Date(), 7 * 24 * 60 * 60 * 1000] }
                                ]
                            }
                        }
                    }
                }
            }
        },

        {
            $project: {
                teamName: 1,
                employeeIds: 1,
                employees: 1,
                activeEmployeeCount: 1,
                recentlyActiveCount: 1,
                createdAt: 1
            }
        }
    ]);

    return teams;
}

async function generateFeedbackAnalytics(managerId, allEmployeeIds, startDate, daysBack, includeDetailed) {
    const baseQuery = {
        fromManagerId: new mongoose.Types.ObjectId(managerId),
        isDeleted: false,
        createdAt: { $gte: startDate }
    }

    const [feedbackData] = await Feedback.aggregate([
        {
            $match: baseQuery,
        },
        {
            $facet: {
                overallStats: [
                    {
                        $group: {
                            _id: null,
                            totalFeedback: { $sum: 1 },
                            acknowledgedFeedback: {
                                $sum: { $cond: [{ $eq: ["$isAcknowledged", true] }, 1, 0] },
                            },
                            pendingFeedback: {
                                $sum: { $cond: [{ $eq: ["$isAcknowledged", false] }, 1, 0] },
                            },
                            avgResponseTime: {
                                $avg: {
                                    $cond: [
                                        { $eq: ["$isAcknowledged", true] },
                                        {
                                            $divide: [
                                                { $subtract: ['$acknowledgedAt', '$createdAt'] },
                                                1000 * 60 * 60 * 24
                                            ]
                                        },
                                        null
                                    ]
                                }
                            }
                        }
                    }
                ],

                sentimentStats: [
                    {
                        $group: {
                            _id: "$sentiment",
                            count: { $sum: 1 },
                            acknowledgedCount: {
                                $sum: {
                                    $cond: [
                                        { $eq: ["$isAcknowledged", true] }, 1, 0
                                    ]
                                }
                            }
                        }
                    }
                ],

                dailyTrend: [
                    {
                        $group: {
                            _id: {
                                $dateToString: {
                                    format: '%Y-%m-%d',
                                    date: '$createdAt'
                                }
                            },
                            count: { $sum: 1 },
                            acknowledged: {
                                $sum: { $cond: [{ $eq: ['$isAcknowledged', true] }, 1, 0] }
                            }
                        }
                    },
                    { $sort: { '_id': 1 } }
                ],

                topEmployees: [
                    {
                        $group: {
                            _id: "$toEmployeeId",
                            feedbackCount: { $sum: 1 },
                            acknowledgedCount: {
                                $sum: {
                                    $cond: [{ $eq: ["$isAcknowledged", true] }, 1, 0]
                                }
                            },
                            latestFeedback: { $max: '$createdAt' },
                            sentiments: { $push: "$sentiments" }
                        }
                    },
                    { $sort: { feedbackCount: -1 } },
                    { $limit: TOP_EMPLOYEES_LIMIT }
                ]
            }
        }
    ])

    const stats = feedbackData.overallStats[0] || {
        totalFeedback: 0,
        acknowledgedFeedback: 0,
        pendingFeedback: 0,
        avgResponseTime: 0
    }

    const sentimentStats = {
        positive: 0,
        neutral: 0,
        negative: 0,
    }

    feedbackData.sentimentStats.forEach(sentiment => {
        if (sentimentStats.hasOwnProperty(sentiment._id)) {
            sentimentStats[sentiment._id] = sentiment.count;
        }
    });

    const acknowledgmentRate = stats.totalFeedback > 0 ?
        parseFloat(((stats.acknowledgedFeedback / stats.totalFeedback) * 100).toFixed(1)) : 0;

    const completeDailyTrend = [];
    for (let i = daysBack - 1; i >= 0; i--) {
        const date = new Date(Date.now() - (i * 24 * 60 * 60 * 1000));
        const dateStr = date.toISOString().split('T')[0];

        const existingData = feedbackData.dailyTrend.find(day => day._id === dateStr);
        completeDailyTrend.push({
            date: dateStr,
            count: existingData?.count || 0,
            acknowledged: existingData?.acknowledged || 0
        });
    }

    let processedTopEmployees = feedbackData.topEmployees;

    if (includeDetailed) {
        const employeeIds = feedbackData.topEmployees.map(emp => emp._id);
        const employees = await User.find({
            _id: { $in: employeeIds },
            role: 'employee'
        }).select("name email userProfile").lean();

        const employeeMap = employees.reduce((map, emp) => {
            map[emp._id.toString()] = emp;
            return map;
        }, {});
        // now we are converting the array into objects were the key will be _id and value will be whole employee details , i think the reduce function is best for it to convert employees array into object 
        // here the map is the name of the object map = {} ok , and the emp is were whole employee comes one by and the initial value is {} empty object , so the key is emp._id.toString() = emp usme pura employee ka details dal rahe hai

        processedTopEmployees = feedbackData.topEmployees.map(emp => {
            const employee = employeeMap[emp._id.toString()];
            return {
                employee: employee ? {
                    _id: employee._id,
                    name: employee.name,
                    email: employee.email,
                    userProfile: employee.userProfile,
                } : null,

                feedbackCount: emp.feedbackCount,
                acknowledgedCount: emp.acknowledgedCount,
                acknowledgmentRate: emp.feedbackCount > 0 ?
                    parseFloat(((emp.acknowledgedCount / emp.feedbackCount) * 100).toFixed(1)) : 0,
                latestFeedback: emp.latestFeedback,
                sentimentBreakdown: emp.sentiments.reduce((acc, sentiment) => {
                    acc[sentiment] = (acc[sentiment] || 0) + 1;
                    return acc;
                }, { positive: 0, neutral: 0, negative: 0 })
            }
        });
    } else {
        processedTopEmployees = feedbackData.topEmployees.map(emp => ({
            employeeId: emp._id,
            feedbackCount: emp.feedbackCount,
            acknowledgedCount: emp.acknowledgedCount,
            acknowledgmentRate: emp.feedbackCount > 0 ?
                parseFloat(((emp.acknowledgedCount / emp.feedbackCount) * 100).toFixed(1)) : 0
        }));
    }

    return {
        summary: {
            totalFeedback: stats.totalFeedback,
            acknowledgedFeedback: stats.acknowledgedFeedback,
            pendingFeedback: stats.pendingFeedback,
            acknowledgmentRate,
            averageResponseTime: stats.avgResponseTime ?
                Math.round(stats.avgResponseTime * 10) / 10 : null
        },
        sentimentDistribution: sentimentStats,
        dailyTrend: completeDailyTrend,
        topEmployees: processedTopEmployees,
        performance: {
            feedbackVelocity: parseFloat((stats.totalFeedback / daysBack).toFixed(2)),
            acknowledgmentVelocity: parseFloat((stats.acknowledgedFeedback / daysBack).toFixed(2)),
            responseEfficiency: acknowledgmentRate
        }
    };
}

async function generateEmployeeMetrics(allEmployeeIds) {
    const employeeStats = await User.aggregate([
        {
            $match: {
                _id: { $in: allEmployeeIds },
                isActive: true,
                role: 'employee',
            }
        },
        {
            $addFields: {
                daysSinceLastLogin: {
                    $cond: [
                        "$lastLogin",
                        {
                            $divide: [
                                { $subtract: [new Date(), "$lastLogin"] },
                                86400000
                            ]
                        },
                        999
                    ]
                },
                accountAge: {
                    $divide: [
                        { $subtract: [new Date(), "$createdAt"] },
                        86400000
                    ]
                }
            }
        },
        {
            $group: {
                _id: null,
                totalEmployees: { $sum: 1 },
                activeToday: {
                    $sum: {
                        $cond: [
                            { $lte: ["$daysSinceLastLogin", 1] },
                            1, 0
                        ]
                    }
                },
                activeThisWeek: {
                    $sum: {
                        $cond: [
                            { $lte: ["$daysSinceLastLogin", 7] },
                            1, 0
                        ]
                    }
                },
                activeThisMonth: {
                    $sum: {
                        $cond: [
                            { $lte: ["$daysSinceLastLogin", 30] },
                            1, 0
                        ]
                    }
                },
                newThisMonth: {
                    $sum: {
                        $cond: [
                            { $lte: ["$accountAge", 30] },
                            1, 0
                        ]
                    }
                },
                averageAccountAge: { $avg: "$accountAge" }
            }
        },
        {
            $project: {
                _id: 0,
                totalEmployees: 1,
                activityMetrics: {
                    activeToday: "$activeToday",
                    activeThisWeek: "$activeThisWeek",
                    activeThisMonth: "$activeThisMonth",
                    newThisMonth: "$newThisMonth",
                },
                engagementRates: {
                    dailyEngagement: {
                        $cond: [
                            { $gt: ["$totalEmployees", 0] },
                            { $round: [{ $multiply: [{ $divide: ["$activeToday", "$totalEmployees"] }, 100] }, 1] },
                            0
                        ]
                    },
                    weeklyEngagement: {
                        $cond: [
                            { $gt: ["$totalEmployees", 0] },
                            { $round: [{ $multiply: [{ $divide: ["$activeThisWeek", "$totalEmployees"] }, 100] }, 1] },
                            0
                        ]
                    },
                    monthlyEngagement: {
                        $cond: [
                            { $gt: ["$totalEmployees", 0] },
                            { $round: [{ $multiply: [{ $divide: ["$activeThisMonth", "$totalEmployees"] }, 100] }, 1] },
                            0
                        ]
                    }
                },
                averageAccountAge: { $round: ["$averageAccountAge", 1] }
            }
        }
    ]);

    return employeeStats[0] || {
        totalEmployees: 0,
        activityMetrics: { activeToday: 0, activeThisWeek: 0, activeThisMonth: 0, newThisMonth: 0 },
        engagementRates: { dailyEngagement: 0, weeklyEngagement: 0, monthlyEngagement: 0 },
        averageAccountAge: 0
    };
}

async function generateTeamOverview(managerTeams) {
    const totalEmployees = managerTeams.reduce(
        (sum, team) => sum + (team.activeEmployeeCount || 0),
        0
    );
    if (!totalEmployees) {
        console.log("team", managerTeams);
        console.log("managers", totalEmployees);
    }
    const totalRecentlyActive = managerTeams.reduce((sum, team) => sum + team.recentlyActiveCount, 0);

    return {
        teams: managerTeams.map(team => ({
            _id: team._id,
            teamName: team.teamName,
            activeEmployees: team.activeEmployeeCount,
            recentlyActiveEmployees: team.recentlyActiveCount,
            activityRate: team.activeEmployeeCount > 0 ?
                Math.round((team.recentlyActiveCount / team.activeEmployeeCount) * 100) : 0,
            employees: team.employees.map(emp => ({
                _id: emp._id,
                name: emp.name,
                email: emp.email,
                userProfile: emp.userProfile,
                isRecentlyActive: emp.lastLogin &&
                    (new Date() - new Date(emp.lastLogin)) <= (7 * 24 * 60 * 60 * 1000)
            }))
        })),
        summary: {
            totalTeams: managerTeams.length,
            totalEmployees,
            recentlyActiveEmployees: totalRecentlyActive,
            averageTeamSize: totalEmployees > 0 ? Math.round(totalEmployees / managerTeams.length) : 0,
            overallActivityRate: totalEmployees > 0 ? Math.round((totalRecentlyActive / totalEmployees) * 100) : 0
        }
    };
}

async function generateRecentActivity(managerId, allEmployeeIds) {
    const recentActivities = await Feedback.aggregate([
        {
            $match: {
                fromManagerId: new mongoose.Types.ObjectId(managerId),
                toEmployeeId: { $in: allEmployeeIds },
                isDeleted: false,
                createdAt: {
                    $gte: new Date(Date.now() - 30 * 24 * 60 * 60 * 1000) // Last 30 days
                }
            }
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
                            userProfile: 1,
                        }
                    }
                ]
            }
        },
        {
            $addFields: {
                employee: {
                    $arrayElemAt: ["$employeeInfo", 0],
                },
                activityType: "feedback_created",
            }
        },
        {
            $project: {
                _id: 1,
                activityType: 1,
                sentiment: 1,
                employee: 1,
                isAcknowledged: 1,
                createdAt: 1,
                acknowledgedAt: 1
            }
        },
        { $sort: { createdAt: -1 } },
        { $limit: RECENT_ACTIVITY_LIMIT }
    ]);

    return {
        activities: recentActivities,
        totalActivities: recentActivities.length,
        timeRange: "Last 30 days"
    }
}

async function generatePerformanceInsights(allEmployeeIds, includeDetailed) {
    const performanceData = await Feedback.aggregate([
        {
            $match: {
                toEmployeeId: { $in: allEmployeeIds },
                isDeleted: false,
            }
        },
        {
            $group: {
                _id: "$toEmployeeId",
                totalFeedback: { $sum: 1 },
                positiveFeedback: {
                    $sum: { $cond: [{ $eq: ["$sentiment", "positive"] }, 1, 0] }
                },
                acknowledgedCount: {
                    $sum: { $cond: ["$isAcknowledged", 1, 0] }
                },
                averageResponseTime: {
                    $avg: {
                        $cond: [
                            "$isAcknowledged",
                            {
                                $divide: [
                                    { $subtract: ["$acknowledgedAt", "$createdAt"] },
                                    86400000
                                ]
                            },
                            null
                        ]
                    }
                }
            }
        },
        {
            $addFields: {
                positiveRatio: {
                    $cond: [
                        { $gt: ["$totalFeedback", 0] },
                        { $divide: ["$positiveFeedback", "$totalFeedback"] },
                        0
                    ]
                },
                acknowledgmentRate: {
                    $cond: [
                        { $gt: ["$totalFeedback", 0] },
                        { $divide: ["$acknowledgedCount", "$totalFeedback"] },
                        0
                    ]
                },
                performanceScore: {
                    $add: [
                        {
                            $multiply: [
                                {
                                    $cond: [
                                        { $gt: ["$totalFeedback", 0] },
                                        { $divide: ["$positiveFeedback", "$totalFeedback"] },
                                        0
                                    ]
                                },
                                0.6
                            ]
                        },
                        {
                            $multiply: [
                                {
                                    $cond: [
                                        { $gt: ["$totalFeedback", 0] },
                                        { $divide: ["$acknowledgedCount", "$totalFeedback"] },
                                        0
                                    ]
                                },
                                0.4
                            ]
                        }
                    ]
                }
            }
        },
        { $sort: { performanceScore: -1, totalFeedback: -1 } },
        { $limit: 5 }
    ]);

    let processedPerformanceData = performanceData;
    if (includeDetailed) {
        const employeeIds = performanceData.map(emp => emp._id);
        const employees = await User.find({
            _id: { $in: employeeIds },
            role: 'employee'
        }).select("name email userProfile").lean();

        const employeeMap = employees.reduce((map, emp) => {
            map[emp._id.toString()] = emp;
            return map;
        }, {});

        processedPerformanceData = performanceData.map(emp => {
            const employee = employeeMap[emp._id.toString()];
            return {
                employee: employee ? {
                    _id: employee._id,
                    name: employee.name,
                    email: employee.email,
                    userProfile: employee.userProfile,

                } : null,
                totalFeedback: emp.totalFeedback,
                positiveFeedback: emp.positiveFeedback,
                acknowledgedCount: emp.acknowledgedCount,
                acknowledgmentRate: Math.round(emp.acknowledgmentRate * 100 * 10) / 10,
                positiveRatio: Math.round(emp.positiveRatio * 100 * 10) / 10,
                performanceScore: Math.round(emp.performanceScore * 100 * 10) / 10,
                averageResponseTime: emp.averageResponseTime ?
                    Math.round(emp.averageResponseTime * 10) / 10 : null
            };
        });
    } else {
        processedPerformanceData = performanceData.map(emp => ({
            employeeId: emp._id,
            totalFeedback: emp.totalFeedback,
            performanceScore: Math.round(emp.performanceScore * 100 * 10) / 10,
            acknowledgmentRate: Math.round(emp.acknowledgmentRate * 100 * 10) / 10
        }));
    }

    return {
        topPerformers: processedPerformanceData,
        criteriaUsed: "Positive feedback ratio (60%) + Acknowledgment rate (40%)",
        totalAnalyzed: allEmployeeIds.length
    };
}

async function getEmployeeTeamInfo(employeeId) {
    try {
        if (!employeeId) {
            throw new ApiError(400, "employeeId is not available");
        }
        const teamInfo = await Team.findOne({
            employeeIds: new mongoose.Types.ObjectId(employeeId),
            isActive: true,
        }).populate('managerId', 'name email userProfile').lean();

        if (!teamInfo) {
            return null;
        }

        return {
            _id: teamInfo._id,
            teamName: teamInfo.teamName,
            manager: teamInfo.managerId,
            totalMembers: teamInfo.employeeIds.length,
            joinedAt: teamInfo.createdAt
        }
    } catch (error) {
        console.warn('Failed to fetch team info:', error.message);
        return null;
    }
}

async function generateFeedbackOverview(employeeId, startDate, daysBack) {
    const [feedbackData] = await Feedback.aggregate([
        {
            $match: {
                toEmployeeId: new mongoose.Types.ObjectId(employeeId),
                isDeleted: false,
                createdAt: { $gte: startDate }
            }
        },
        {
            $facet: {
                overallStats: [
                    {
                        $group: {
                            _id: null,
                            totalFeedback: { $sum: 1 },
                            acknowledgedFeedback: {
                                $sum: { $cond: [{ $eq: ["$isAcknowledged", true] }, 1, 0] },
                            },
                            pendingFeedback: {
                                $sum: { $cond: [{ $eq: ["$isAcknowledged", false] }, 1, 0] },
                            },
                            avgResponseTime: {
                                $avg: {
                                    $cond: [
                                        { $eq: ["$isAcknowledged", true] },
                                        {
                                            $divide: [
                                                { $subtract: ['$acknowledgedAt', '$createdAt'] },
                                                1000 * 60 * 60 * 24
                                            ]
                                        },
                                        null
                                    ]
                                }
                            },
                            recentFeedback: {
                                $sum: {
                                    $cond: [
                                        {
                                            $gte: [
                                                '$createdAt',
                                                { $subtract: [new Date(), 7 * 24 * 60 * 60 * 1000] }
                                            ]
                                        },
                                        1,
                                        0
                                    ]
                                }
                            }

                        }
                    }
                ],

                sentimentStats: [
                    {
                        $group: {
                            _id: "$sentiment",
                            count: { $sum: 1 },
                            acknowledgedCount: {
                                $sum: { $cond: [{ $eq: ["$isAcknowledged", true] }, 1, 0] }
                            },
                            avgResponseTime: {
                                $avg: {
                                    $cond: [
                                        { $eq: ["$isAcknowledged", true] },
                                        {
                                            $divide: [
                                                { $subtract: ['$acknowledgedAt', '$createdAt'] },
                                                1000 * 60 * 60 * 24
                                            ]
                                        },
                                        null
                                    ]
                                }
                            }
                        }
                    }
                ],
                dailyTrend: [
                    {
                        $group: {
                            _id: {
                                $dateToString: {
                                    format: '%Y-%m-%d',
                                    date: '$createdAt'
                                }
                            },
                            count: { $sum: 1 },
                            acknowledged: {
                                $sum: { $cond: [{ $eq: ['$isAcknowledged', true] }, 1, 0] }
                            },
                            sentiments: { $push: '$sentiment' }
                        }
                    },
                    { $sort: { '_id': 1 } }
                ],

                monthlyTrend: [
                    {
                        $group: {
                            _id: {
                                year: { $year: '$createdAt' },
                                month: { $month: '$createdAt' }
                            },
                            count: { $sum: 1 },
                            acknowledged: {
                                $sum: { $cond: [{ $eq: ["$isAcknowledged", true] }, 1, 0] }
                            },
                            positive: {
                                $sum: { $cond: [{ $eq: ["$sentiment", 'positive'] }, 1, 0] },
                            },
                            negative: {
                                $sum: { $cond: [{ $eq: ["$sentiment", 'negative'] }, 1, 0] },
                            },
                        }
                    },
                    { $sort: { '_id.year': -1, '_id.month': -1 } },
                    { $limit: 6 }
                ],

                managerBreakdown: [
                    {
                        $group: {
                            _id: "$fromManagerId",

                            feedbackCount: { $sum: 1 },
                            acknowledgedCount: {
                                $sum: { $cond: [{ $eq: ["$isAcknowledged", true] }, 1, 0] }
                            },
                            sentimentBreakdown: { $push: "$sentiment" },
                            latestFeedback: { $max: '$createdAt' },
                            avgResponseTime: {
                                $avg: {
                                    $cond: [
                                        { $eq: ["$isAcknowledged", true] },
                                        {
                                            $divide: [
                                                { $subtract: ['$acknowledgedAt', '$createdAt'] },
                                                1000 * 60 * 60 * 24
                                            ]
                                        },
                                        null
                                    ]
                                }
                            }
                        }
                    },
                    {
                        $lookup: {
                            from: "users",
                            localField: "_id",
                            foreignField: "_id",
                            as: "managerInfo",
                            pipeline: [
                                {
                                    $project: {
                                        name: 1,
                                        email: 1,
                                        userProfile: 1,
                                    }
                                }
                            ]
                        }
                    },
                    {
                        $addFields: {
                            manager: {
                                $arrayElemAt: ["$managerInfo", 0],
                            },
                            acknowledgmentRate: {
                                $cond: [
                                    { $gt: ['$feedbackCount', 0] },
                                    { $multiply: [{ $divide: ['$acknowledgedCount', '$feedbackCount'] }, 100] },
                                    0
                                ]
                            },
                            sentimentStats: {
                                $reduce: {
                                    input: "$sentimentBreakdown",
                                    initialValue: { positive: 0, neutral: 0, negative: 0 },
                                    in: {
                                        positive: {
                                            $cond: [
                                                { $eq: ["$$this", 'positive'] },
                                                { $add: ["$$value.positive", 1] },
                                                '$$value.positive'
                                            ]
                                        },
                                        neutral: {
                                            $cond: [
                                                { $eq: ["$$this", 'neutral'] },
                                                { $add: ["$$value.neutral", 1] },
                                                '$$value.neutral'
                                            ]
                                        },
                                        negative: {
                                            $cond: [
                                                { $eq: ["$$this", 'negative'] },
                                                { $add: ["$$value.negative", 1] },
                                                "$$value.negative"
                                            ]
                                        }
                                    }
                                }
                            }
                        }
                    },
                    { $sort: { feedbackCount: -1 } }
                ]
            }
        }
    ]);

    const stats = feedbackData.overallStats[0] || {
        totalFeedback: 0,
        acknowledgedFeedback: 0,
        pendingFeedback: 0,
        avgResponseTime: 0,
        recentFeedback: 0
    }

    const sentimentStats = {
        positive: 0,
        neutral: 0,
        negative: 0
    };

    feedbackData.sentimentStats.forEach(sentiment => {
        if (sentimentStats.hasOwnProperty(sentiment._id)) {
            sentimentStats[sentiment._id] = {
                count: sentiment.count,
                acknowledgedCount: sentiment.acknowledgedCount,
                acknowledgmentRate: sentiment.count > 0 ?
                    Math.round((sentiment.acknowledgedCount / sentiment.count) * 100 * 10) / 10 : 0,
                avgResponseTime: sentiment.avgResponseTime ?
                    Math.round(sentiment.avgResponseTime * 10) / 10 : null
            }
        }
    })

    const acknowledgmentRate = stats.totalFeedback > 0 ?
        parseFloat(((stats.acknowledgedFeedback / stats.totalFeedback) * 100).toFixed(1)) : 0;

    const completeDailyTrend = [];
    for (let i = daysBack - 1; i >= 0; i--) {
        const date = new Date(Date.now() - (i * 24 * 60 * 60 * 1000));
        const dateStr = date.toISOString().split('T')[0];

        const existingData = feedbackData.dailyTrend.find(day => day._id === dateStr);
        if (existingData) {
            const sentimentCounts = existingData.sentiments.reduce((acc, sentiment) => {
                acc[sentiment] = (acc[sentiment] || 0) + 1;
                return acc;
            }, { positive: 0, neutral: 0, negative: 0 });

            completeDailyTrend.push({
                date: dateStr,
                count: existingData.count,
                acknowledged: existingData.acknowledged,
                sentimentBreakdown: sentimentCounts
            });
        } else {
            completeDailyTrend.push({
                date: dateStr,
                count: 0,
                acknowledged: 0,
                sentimentBreakdown: { positive: 0, neutral: 0, negative: 0 }
            });
        }
    }

    return {
        totalFeedback: stats.totalFeedback,
        acknowledgedFeedback: stats.acknowledgedFeedback,
        pendingFeedback: stats.pendingFeedback,
        acknowledgmentRate,
        averageResponseTime: stats.avgResponseTime ?
            Math.round(stats.avgResponseTime * 10) / 10 : null,
        recentFeedbackCount: stats.recentFeedback,
        sentimentDistribution: sentimentStats,
        dailyTrend: completeDailyTrend,
        monthlyTrend: feedbackData.monthlyTrend,
        managerBreakdown: feedbackData.managerBreakdown
    }
}

async function generateFeedbackHistory(employeeId, historyDays) {
    const historyStartDate = new Date(Date.now() - historyDays * 24 * 60 * 60 * 1000);

    const feedbackHistory = await Feedback.aggregate([
        {
            $match: {
                toEmployeeId: new mongoose.Types.ObjectId(employeeId),
                isDeleted: false,
                createdAt: { $gte: historyStartDate }
            }
        },
        {
            $lookup: {
                from: "users",
                localField: "fromManagerId",
                foreignField: "_id",
                as: 'managerInfo',
                pipeline: [
                    {
                        $project: {
                            name: 1,
                            email: 1,
                            userProfile: 1
                        }
                    }
                ]
            }
        },
        {
            $addFields: {
                manager: {
                    $arrayElemAt: ["$managerInfo", 0],
                },
                responseTime: {
                    $cond: [
                        '$isAcknowledged',
                        {
                            $divide: [
                                { $subtract: ['$acknowledgedAt', '$createdAt'] },
                                1000 * 60 * 60 * 24
                            ]
                        },
                        null
                    ]
                },
                daysAgo: {
                    $divide: [
                        { $subtract: [new Date(), '$createdAt'] },
                        1000 * 60 * 60 * 24
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
                createdAt: 1,
                acknowledgedAt: 1,
                manager: 1,
                responseTime: { $round: ['$responseTime', 1] },
                daysAgo: { $round: ['$daysAgo', 0] },
                version: 1
            }
        },
        { $sort: { createdAt: -1 } },
        { $limit: CONFIG.RECENT_FEEDBACK_LIMIT }
    ]);

    const groupedFeedback = {
        thisWeek: [],
        lastWeek: [],
        thisMonth: [],
        older: []
    };

    const oneWeekAgo = 7;
    const twoWeeksAgo = 14;
    const oneMonthAgo = 30;

    feedbackHistory.forEach(feedback => {
        if (feedback.daysAgo <= oneWeekAgo) {
            groupedFeedback.thisWeek.push(feedback);
        } else if (feedback.daysAgo <= twoWeeksAgo) {
            groupedFeedback.lastWeek.push(feedback);
        } else if (feedback.daysAgo <= oneMonthAgo) {
            groupedFeedback.thisMonth.push(feedback);
        } else {
            groupedFeedback.older.push(feedback);
        }
    });

    return {
        recentFeedback: feedbackHistory,
        groupedFeedback,
        summary: {
            totalInPeriod: feedbackHistory.length,
            acknowledgedInPeriod: feedbackHistory.filter(f => f.isAcknowledged).length,
            averageResponseTime: feedbackHistory
                .filter(f => f.responseTime !== null)
                .reduce((sum, f, _, arr) => sum + f.responseTime / arr.length, 0) || null,
            timeRange: `Last ${historyDays} days`
        }
    };
};

async function generatePerformanceMetrics(employeeId, startDate) {
    const performanceData = await Feedback.aggregate([
        {
            $match: {
                toEmployeeId: new mongoose.Types.ObjectId(employeeId),
                isDeleted: false
            }
        },
        {
            $facet: {
                currentPeriod: [
                    {
                        $match: {
                            createdAt: { $gte: startDate }
                        }
                    },
                    {
                        $group: {
                            _id: null,
                            totalFeedback: { $sum: 1 },
                            positiveFeedback: {
                                $sum: { $cond: [{ $eq: ['$sentiment', 'positive'] }, 1, 0] }
                            },
                            neutralFeedback: {
                                $sum: { $cond: [{ $eq: ["$sentiment", 'neutral'] }, 1, 0] }
                            },
                            negativeFeedback: {
                                $sum: { $cond: [{ $eq: ["$sentiment", 'negative'] }, 1, 0] }
                            },
                            acknowledgedCount: {
                                $sum: { $cond: ['$isAcknowledged', 1, 0] }
                            },
                            avgResponseTime: {
                                $avg: {
                                    $cond: [
                                        '$isAcknowledged',
                                        {
                                            $divide: [
                                                { $subtract: ['$acknowledgedAt', '$createdAt'] },
                                                1000 * 60 * 60 * 24
                                            ]
                                        },
                                        null,
                                    ]
                                }
                            }
                        }
                    }
                ],
                previousPeriod: [
                    {
                        $match: {
                            createdAt: {
                                $gte: new Date(startDate.getTime() - (startDate.getTime() - new Date(startDate.getTime() - 30 * 24 * 60 * 60 * 1000).getTime())),
                                $lt: startDate
                            }
                        }
                    },
                    {
                        $group: {
                            _id: null,
                            totalFeedback: { $sum: 1 },
                            positiveFeedback: {
                                $sum: { $cond: [{ $eq: ['$sentiment', 'positive'] }, 1, 0] }
                            },
                            acknowledgedCount: {
                                $sum: { $cond: ['$isAcknowledged', 1, 0] }
                            },
                            avgResponseTime: {
                                $avg: {
                                    $cond: [
                                        '$isAcknowledged',
                                        {
                                            $divide: [
                                                { $subtract: ['$acknowledgedAt', '$createdAt'] },
                                                1000 * 60 * 60 * 24
                                            ]
                                        },
                                        null
                                    ]
                                }
                            }
                        }
                    }
                ],
                allTime: [
                    {
                        $group: {
                            _id: null,
                            totalFeedback: { $sum: 1 },
                            positiveFeedback: {
                                $sum: { $cond: [{ $eq: ['$sentiment', 'positive'] }, 1, 0] }
                            },
                            acknowledgedCount: {
                                $sum: { $cond: ['$isAcknowledged', 1, 0] }
                            },
                            avgResponseTime: {
                                $avg: {
                                    $cond: [
                                        '$isAcknowledged',
                                        {
                                            $divide: [
                                                { $subtract: ['$acknowledgedAt', '$createdAt'] },
                                                1000 * 60 * 60 * 24
                                            ]
                                        },
                                        null
                                    ]
                                }
                            }
                        }
                    }
                ]
            }
        }
    ]);

    const [metrics] = performanceData;
    const current = metrics.currentPeriod[0] || {};
    const previous = metrics.previousPeriod[0] || {};
    const allTime = metrics.allTime[0] || {};

    const calculateChange = (current, previous) => {
        if (!previous || previous === 0) return current > 0 ? 100 : 0;
        return Math.round(((current - previous) / previous) * 100 * 10) / 10;
    };

    return {
        currentPeriod: {
            totalFeedback: current.totalFeedback || 0,
            positiveFeedback: current.positiveFeedback || 0,
            neutralFeedback: current.neutralFeedback || 0,
            negativeFeedback: current.negativeFeedback || 0,
            acknowledgedCount: current.acknowledgedCount || 0,
            positiveRate: current.totalFeedback > 0 ?
                Math.round((current.positiveFeedback / current.totalFeedback) * 100 * 10) / 10 : 0,
            acknowledgmentRate: current.totalFeedback > 0 ?
                Math.round((current.acknowledgedCount / current.totalFeedback) * 100 * 10) / 10 : 0,
            avgResponseTime: current.avgResponseTime ?
                Math.round(current.avgResponseTime * 10) / 10 : null
        },
        previousPeriod: {
            totalFeedback: previous.totalFeedback || 0,
            positiveFeedback: previous.positiveFeedback || 0,
            acknowledgedCount: previous.acknowledgedCount || 0,
            positiveRate: previous.totalFeedback > 0 ?
                Math.round((previous.positiveFeedback / previous.totalFeedback) * 100 * 10) / 10 : 0,
            acknowledgmentRate: previous.totalFeedback > 0 ?
                Math.round((previous.acknowledgedCount / previous.totalFeedback) * 100 * 10) / 10 : 0
        },

        allTime: {
            totalFeedback: allTime.totalFeedback || 0,
            positiveFeedback: allTime.positiveFeedback || 0,
            acknowledgedCount: allTime.acknowledgedCount || 0,
            positiveRate: allTime.totalFeedback > 0 ?
                Math.round((allTime.positiveFeedback / allTime.totalFeedback) * 100 * 10) / 10 : 0,
            acknowledgmentRate: allTime.totalFeedback > 0 ?
                Math.round((allTime.acknowledgedCount / allTime.totalFeedback) * 100 * 10) / 10 : 0,
            avgResponseTime: allTime.avgResponseTime ?
                Math.round(allTime.avgResponseTime * 10) / 10 : null
        },

        trends: {
            feedbackChange: calculateChange(current.totalFeedback || 0, previous.totalFeedback || 0),
            positiveRateChange: calculateChange(
                current.totalFeedback > 0 ? (current.positiveFeedback / current.totalFeedback) * 100 : 0,
                previous.totalFeedback > 0 ? (previous.positiveFeedback / previous.totalFeedback) * 100 : 0
            ),
            acknowledgmentRateChange: calculateChange(
                current.totalFeedback > 0 ? (current.acknowledgedCount / current.totalFeedback) * 100 : 0,
                previous.totalFeedback > 0 ? (previous.acknowledgedCount / previous.totalFeedback) * 100 : 0
            )
        }
    };

}

async function generateTeamComparison(employeeId, teamId, startDate) {
    const teamComparison = await Team.aggregate([
        {
            $match: {
                _id: new mongoose.Types.ObjectId(teamId),
                isActive: true
            }
        },
        {
            $lookup: {
                from: "feedback",
                let: { employeeIds: '$employeeIds' },
                pipeline: [
                    {
                        $match: {
                            $expr: {
                                $and: [
                                    { $in: ["$toEmployeeId", "$employeeIds"] },
                                    { $eq: ["$isDeleted", false] },
                                    { $gte: ['$createdAt', startDate] }
                                ]
                            }
                        }
                    }
                ],
                as: "teamFeedbacks"
            }
        },
        {
            $lookup: {
                from: "feedbacks",
                pipeline: [
                    {
                        $match: {
                            toEmployeeId: new mongoose.Types.ObjectId(employeeId),
                            isDeleted: false,
                            createdAt: { $gte: startDate }
                        }
                    }
                ],
                as: "employeeFeedbacks",
            }
        },
        {
            $addFields: {
                teamStats: {
                    $reduce: {
                        input: '$teamFeedbacks',
                        initialValue: {
                            totalFeedback: 0,
                            acknowledgedFeedback: 0,
                            positiveFeedback: 0,
                            neutralFeedback: 0,
                            negativeFeedback: 0,
                            totalResponseTime: 0,
                            acknowledgedCount: 0
                        },
                        in: {
                            totalFeedback: { $add: ['$value.totalFeedback', 1] },
                            acknowledgedFeedback: {
                                $add: ["$value.acknowledgedFeedback",
                                    {
                                        $cond: ["$this.isAcknowledged", 1, 0]
                                    }
                                ]
                            },
                            positiveFeedback: {
                                $add: ["$value.positiveFeedback",
                                    {
                                        $cond: [{ $eq: ["$this.positiveFeedback", "positive"] }, 1, 0]
                                    }
                                ]
                            },
                            neutralFeedback: {
                                $add: ["$value.neutralFeedback", {
                                    $cond: [{ $eq: ["$this.neutralFeedback", 'neutral'] }, 1, 0]
                                }]
                            },
                            negativeFeedback: {
                                $add: ["$value.negativeFeedback", {
                                    $cond: [{ $eq: ["$this.negativeFeedback", 'negative'] }, 1, 0]
                                }]
                            },
                            totalResponseTime: {
                                $add: [
                                    "$value.totalResponseTime",
                                    {
                                        $cond: [
                                            '$this.isAcknowledged',
                                            {
                                                $divide: [
                                                    { $subtract: ['$this.acknowledgedAt', '$this.createdAt'] },
                                                    1000 * 60 * 60 * 24
                                                ]
                                            },
                                            0
                                        ]
                                    }
                                ]
                            },
                            acknowledgedCount: {
                                $add: [
                                    "$value.acknowledgedCount",
                                    { $cond: ['$this.isAcknowledged', 1, 0] }
                                ]
                            }
                        }
                    }
                },

                employeeStats: {
                    $reduce: {
                        input: "$employeeFeedbacks",
                        initialValue: {
                            totalFeedback: 0,
                            acknowledgedFeedback: 0,
                            positiveFeedback: 0,
                            neutralFeedback: 0,
                            negativeFeedback: 0,
                            totalResponseTime: 0,
                            acknowledgedCount: 0
                        },
                        in: {
                            totalFeedback: { $add: ['$value.totalFeedback', 1] },
                            acknowledgedFeedback: {
                                $add: [
                                    '$value.acknowledgedFeedback',
                                    { $cond: ["$this.isAcknowledged", 1, 0] }
                                ]
                            },
                            positiveFeedback: {
                                $add: [
                                    "$value.positiveFeedback",
                                    { $cond: [{ $eq: ["$this.sentiment", 'positive'] }, 1, 0] }
                                ]
                            },
                            neutralFeedback: {
                                $add: [
                                    '$value.neutralFeedback',
                                    { $cond: [{ $eq: ['$this.sentiment', 'neutral'] }, 1, 0] }
                                ]
                            },
                            negativeFeedback: {
                                $add: [
                                    '$value.negativeFeedback',
                                    { $cond: [{ $eq: ['$this.sentiment', 'negative'] }, 1, 0] }
                                ]
                            },
                            totalResponseTime: {
                                $add: [
                                    '$value.totalResponseTime',
                                    {
                                        $cond: [
                                            '$this.isAcknowledged',
                                            {
                                                $divide: [
                                                    { $subtract: ['$this.acknowledgedAt', '$this.createdAt'] },
                                                    1000 * 60 * 60 * 24
                                                ]
                                            },
                                            0
                                        ]
                                    }
                                ]
                            },
                            acknowledgedCount: {
                                $add: [
                                    '$value.acknowledgedCount',
                                    { $cond: ['$this.isAcknowledged', 1, 0] }
                                ]
                            },
                        }
                    }
                }

            }
        },
        {
            $project: {
                teamName: 1,
                totalMembers: { $size: '$employeeIds' },
                team: {
                    totalFeedback: "$teamStats.totalFeedback",
                    acknowledgedFeedback: "$teamStats.acknowledgedFeedback",
                    acknowledgmentRate: {
                        $cond: [
                            { $gt: ['$teamStats.totalFeedback', 0] },
                            { $multiply: [{ $divide: ['$teamStats.acknowledgedFeedback', '$teamStats.totalFeedback'] }, 100] },
                            0
                        ]
                    },
                    positiveRate: {
                        $cond: [
                            { $gt: ['$teamStats.totalFeedback', 0] },
                            { $multiply: [{ $divide: ['$teamStats.positiveFeedback', '$teamStats.totalFeedback'] }, 100] },
                            0
                        ]
                    },
                    avgResponseTime: {
                        $cond: [
                            { $gt: ['$teamStats.acknowledgedCount', 0] },
                            { $divide: ['$teamStats.totalResponseTime', '$teamStats.acknowledgedCount'] },
                            null
                        ]
                    }
                },
                employee: {
                    totalFeedback: '$employeeStats.totalFeedback',
                    acknowledgedFeedback: '$employeeStats.acknowledgedFeedback',
                    acknowledgmentRate: {
                        $cond: [
                            { $gt: ['$employeeStats.totalFeedback', 0] },
                            { $multiply: [{ $divide: ['$employeeStats.acknowledgedFeedback', '$employeeStats.totalFeedback'] }, 100] },
                            0
                        ]
                    },
                    positiveRate: {
                        $cond: [
                            { $gt: ['$employeeStats.totalFeedback', 0] },
                            { $multiply: [{ $divide: ['$employeeStats.positiveFeedback', '$employeeStats.totalFeedback'] }, 100] },
                            0
                        ]
                    },
                    avgResponseTime: {
                        $cond: [
                            { $gt: ['$employeeStats.acknowledgedCount', 0] },
                            { $divide: ['$employeeStats.totalResponseTime', '$employeeStats.acknowledgedCount'] },
                            null
                        ]
                    }
                }
            }
        }
    ]);

    if (!teamComparison.length) {
        return null;
    }

    const comparison = teamComparison[0];

    const teamAvgFeedback = comparison.totalMembers > 0 ?
        Math.round((comparison.team.totalFeedback / comparison.totalMembers) * 10) / 10 : 0;
    const teamAvgAcknowledged = comparison.totalMembers > 0 ?
        Math.round((comparison.team.acknowledgedFeedback / comparison.totalMembers) * 10) / 10 : 0;

    return {
        teamName: comparison.teamName,
        totalMembers: comparison.totalMembers,
        comparison: {
            feedbackReceived: {
                employee: comparison.employee.totalFeedback,
                teamAverage: teamAvgFeedback,
                percentile: calculatePercentile(comparison.employee.totalFeedback, teamAvgFeedback)
            },
            acknowledgmentRate: {
                employee: Math.round(comparison.employee.acknowledgmentRate * 10) / 10,
                teamAverage: Math.round(comparison.team.acknowledgmentRate * 10) / 10,
                percentile: calculatePercentile(comparison.employee.acknowledgmentRate, comparison.team.acknowledgmentRate)
            },
            positiveRate: {
                employee: Math.round(comparison.employee.positiveRate * 10) / 10,
                teamAverage: Math.round(comparison.team.positiveRate * 10) / 10,
                percentile: calculatePercentile(comparison.employee.positiveRate, comparison.team.positiveRate)
            },
            responseTime: {
                employee: comparison.employee.avgResponseTime ?
                    Math.round(comparison.employee.avgResponseTime * 10) / 10 : null,
                teamAverage: comparison.team.avgResponseTime ?
                    Math.round(comparison.team.avgResponseTime * 10) / 10 : null,
                percentile: comparison.employee.avgResponseTime && comparison.team.avgResponseTime ?
                    calculatePercentile(comparison.employee.avgResponseTime, comparison.team.avgResponseTime, true) : null
            }
        }
    }
};

async function generatePerformanceTrends(employeeId, trendMonths) {
    const trendsData = await Feedback.aggregate([
        {
            $match: {
                toEmployeeId: new mongoose.Types.ObjectId(employeeId),
                isDeleted: false,
                createdAt: {
                    $gte: new Date(Date.now() - trendMonths * 30 * 24 * 60 * 60 * 1000)
                }
            }
        },
        {
            $group: {
                _id: {
                    year: { $year: '$createdAt' },
                    month: { $month: '$createdAt' }
                },
                totalFeedback: { $sum: 1 },
                acknowledgedFeedback: {
                    $sum: { $cond: ["$isAcknowledged", 1, 0] }
                },
                positiveFeedback: {
                    $sum: { $cond: [{ $eq: ["$sentiment", 'positive'] }, 1, 0] }
                },
                neutralFeedback: {
                    $sum: { $cond: [{ $eq: ["$sentiment", 'neutral'] }, 1, 0] }
                },
                negativeFeedback: {
                    $sum: { $cond: [{ $eq: ["$sentiment", 'negative'] }, 1, 0] }
                },
                avgResponseTime: {
                    $avg: {
                        $cond: [
                            '$isAcknowledged',
                            {
                                $divide: [
                                    { $subtract: ['$acknowledgedAt', '$createdAt'] },
                                    1000 * 60 * 60 * 24
                                ]
                            },
                            null
                        ]
                    }
                }
            }
        },
        {
            $addFields: {
                acknowledgmentRate: {
                    $cond: [
                        { $gt: ['$totalFeedback', 0] },
                        { $multiply: [{ $divide: ['$acknowledgedFeedback', '$totalFeedback'] }, 100] },
                        0
                    ]
                },
                positiveRate: {
                    $cond: [
                        { $gt: ['$totalFeedback', 0] },
                        { $multiply: [{ $divide: ['$positiveFeedback', '$totalFeedback'] }, 100] },
                        0
                    ]
                },

                monthName: {
                    $switch: {
                        branches: [
                            { case: { $eq: ['$_id.month', 1] }, then: 'Jan' },
                            { case: { $eq: ['$_id.month', 2] }, then: 'Feb' },
                            { case: { $eq: ['$_id.month', 3] }, then: 'Mar' },
                            { case: { $eq: ['$_id.month', 4] }, then: 'Apr' },
                            { case: { $eq: ['$_id.month', 5] }, then: 'May' },
                            { case: { $eq: ['$_id.month', 6] }, then: 'Jun' },
                            { case: { $eq: ['$_id.month', 7] }, then: 'Jul' },
                            { case: { $eq: ['$_id.month', 8] }, then: 'Aug' },
                            { case: { $eq: ['$_id.month', 9] }, then: 'Sep' },
                            { case: { $eq: ['$_id.month', 10] }, then: 'Oct' },
                            { case: { $eq: ['$_id.month', 11] }, then: 'Nov' },
                            { case: { $eq: ['$_id.month', 12] }, then: 'Dec' }
                        ],
                        default: 'Unknown'
                    }
                }
            }
        },
        {
            $sort: { '_id.year': -1, '_id.month': -1 }
        },
        {
            $limit: trendMonths
        }
    ]);

    const completeTrends = [];

    for (let i = trendMonths - 1; i >= 0; i--) {
        const date = new Date();
        date.setMonth(date.getMonth() - i);
        const year = date.getFullYear();
        const month = date.getMonth() + 1;

        const existingData = trendsData.find(trend =>
            trend._id.year === year && trend._id.month === month
        );

        if (existingData) {
            completeTrends.push({
                period: `${existingData.monthName} ${existingData._id.year}`,
                year: existingData._id.year,
                month: existingData._id.month,
                totalFeedback: existingData.totalFeedback,
                acknowledgedFeedback: existingData.acknowledgedFeedback,
                acknowledgmentRate: Math.round(existingData.acknowledgmentRate * 10) / 10,
                positiveFeedback: existingData.positiveFeedback,
                neutralFeedback: existingData.neutralFeedback,
                negativeFeedback: existingData.negativeFeedback,
                positiveRate: Math.round(existingData.positiveRate * 10) / 10,
                avgResponseTime: existingData.avgResponseTime ?
                    Math.round(existingData.avgResponseTime * 10) / 10 : null
            });
        } else {
            const monthNames = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun',
                'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
            completeTrends.push({
                period: `${monthNames[month - 1]} ${year}`,
                year,
                month,
                totalFeedback: 0,
                acknowledgedFeedback: 0,
                acknowledgmentRate: 0,
                positiveFeedback: 0,
                neutralFeedback: 0,
                negativeFeedback: 0,
                positiveRate: 0,
                avgResponseTime: null
            });
        }
    }

    const trendAnalysis = calculateTrendAnalysis(completeTrends);

    return {
        monthlyTrends: completeTrends.reverse(), // Show oldest to newest
        analysis: trendAnalysis,
        summary: {
            totalMonths: trendMonths,
            averageFeedbackPerMonth: completeTrends.reduce((sum, trend) => sum + trend.totalFeedback, 0) / trendMonths,
            averageAcknowledgmentRate: completeTrends.reduce((sum, trend) => sum + trend.acknowledgmentRate, 0) / trendMonths,
            averagePositiveRate: completeTrends.reduce((sum, trend) => sum + trend.positiveRate, 0) / trendMonths
        }
    }
}

async function generateAcknowledgmentStats(employeeId, startDate) {
    const acknowledgmentData = await Feedback.aggregate([
        {
            $match: {
                toEmployeeId: new mongoose.Types.ObjectId(employeeId),
                isDeleted: false,
                createdAt: { $gte: startDate }
            }
        },
        {
            $facet: {
                overallStats: [
                    {
                        $group: {
                            _id: null,
                            totalFeedback: { $sum: 1 },
                            acknowledgedCount: {
                                $sum: { $cond: ["$isAcknowledged", 1, 0] }
                            },
                            pendingCount: {
                                $sum: { $cond: [{ $not: "$isAcknowledged" }, 1, 0] }
                            },
                            avgResponseTime: {
                                $avg: {
                                    $cond: [
                                        '$isAcknowledged',
                                        {
                                            $divide: [
                                                { $subtract: ['$acknowledgedAt', '$createdAt'] },
                                                1000 * 60 * 60 * 24
                                            ]
                                        },
                                        null
                                    ]
                                }
                            },
                            fastResponses: {
                                $sum: {
                                    $cond: [
                                        {
                                            $and: [
                                                '$isAcknowledged',
                                                {
                                                    $lte: [
                                                        {
                                                            $divide: [
                                                                { $subtract: ['$acknowledgedAt', '$createdAt'] },
                                                                1000 * 60 * 60 * 24
                                                            ]
                                                        },
                                                        1
                                                    ]
                                                }
                                            ]
                                        },
                                        1,
                                        0
                                    ]
                                }
                            },
                            slowResponses: {
                                $sum: {
                                    $cond: [
                                        {
                                            $and: [
                                                '$isAcknowledged',
                                                {
                                                    $gt: [
                                                        {
                                                            $divide: [
                                                                { $subtract: ['$acknowledgedAt', '$createdAt'] },
                                                                1000 * 60 * 60 * 24
                                                            ]
                                                        },
                                                        7
                                                    ]
                                                }
                                            ]
                                        },
                                        1,
                                        0
                                    ]
                                }
                            },

                        }
                    }
                ],
                sentimentAcknowledgment: [
                    {
                        $group: {
                            _id: '$sentiment',
                            total: { $sum: 1 },
                            acknowledged: {
                                $sum: { $cond: ['$isAcknowledged', 1, 0] }
                            },
                            avgResponseTime: {
                                $avg: {
                                    $cond: [
                                        '$isAcknowledged',
                                        {
                                            $divide: [
                                                { $subtract: ['$acknowledgedAt', '$createdAt'] },
                                                1000 * 60 * 60 * 24
                                            ]
                                        },
                                        null
                                    ]
                                }
                            }
                        }
                    }
                ],
                recentPending: [
                    {
                        $match: {
                            isAcknowledged: false,
                        }
                    },
                    {
                        $addFields: {
                            daysPending: {
                                $divide: [
                                    { $subtract: [new Date(), '$createdAt'] },
                                    1000 * 60 * 60 * 24
                                ]
                            }
                        }
                    },
                    {
                        $sort: { createdAt: -1 }
                    },
                    {
                        $limit: 5
                    },
                    {
                        $lookup: {
                            from: "users",
                            localField: "fromManagerId",
                            foreignField: "_id",
                            as: "manager",
                            pipeline: [
                                {
                                    $project: {
                                        name: 1,
                                        email: 1,
                                        userProfile: 1,
                                    }
                                }
                            ]
                        }
                    },
                    {
                        $project: {
                            _id: 1,
                            sentiment: 1,
                            createdAt: 1,
                            daysPending: { $round: ['$daysPending', 1] },
                            manager: { $arrayElemAt: ['$manager', 0] }
                        }
                    }
                ]
            }
        }
    ]);

    const [stats] = acknowledgmentData;
    const overall = stats.overallStats[0] || {};
    const sentimentAck = {};

    stats.sentimentAcknowledgment.forEach(sentiment => {
        sentimentAck[sentiment._id] = {
            total: sentiment.total,
            acknowledged: sentiment.acknowledged,
            acknowledgmentRate: sentiment.total > 0 ?
                Math.round((sentiment.acknowledged / sentiment.total) * 100 * 10) / 10 : 0,
            avgResponseTime: sentiment.avgResponseTime ?
                Math.round(sentiment.avgResponseTime * 10) / 10 : null
        };
    });

    return {
        overall: {
            totalFeedback: overall.totalFeedback || 0,
            acknowledgedCount: overall.acknowledgedCount || 0,
            pendingCount: overall.pendingCount || 0,
            acknowledgmentRate: overall.totalFeedback > 0 ?
                Math.round((overall.acknowledgedCount / overall.totalFeedback) * 100 * 10) / 10 : 0,
            avgResponseTime: overall.avgResponseTime ?
                Math.round(overall.avgResponseTime * 10) / 10 : null,
            fastResponses: overall.fastResponses || 0,
            slowResponses: overall.slowResponses || 0,
            fastResponseRate: overall.acknowledgedCount > 0 ?
                Math.round((overall.fastResponses / overall.acknowledgedCount) * 100 * 10) / 10 : 0
        },
        bySentiment: sentimentAck,
        recentPending: stats.recentPending,
         insights: {
            responseTimeCategory: categorizeResponseTime(overall.avgResponseTime),
            acknowledgmentTrend: overall.acknowledgmentRate >= 80 ? 'excellent' : 
                                overall.acknowledgmentRate >= 60 ? 'good' : 
                                overall.acknowledgmentRate >= 40 ? 'needs_improvement' : 'poor'
        }
    };
}

async function generateManagerInsights(employeeId, startDate) {
    const managerInsights = await Feedback.aggregate([
        {
            $match : {
                toEmployeeId: new mongoose.Types.ObjectId(employeeId),
                isDeleted: false,
                createdAt: { $gte: startDate }
            }
        },
        {
            $group : {
                _id : "$fromManagerId",
                feedbackCount : {$sum : 1},
                acknowledgedCount : {
                    $sum : { $cond : ["$isAcknowledged" , 1 , 0]}
                },
                positiveCount : {
                    $sum : {$cond : [{$eq : ["$sentiment" , 'positive']} , 1 , 0]}
                },
                neutralCount : {
                    $sum : {$cond : [{$eq : ["$sentiment" , 'neutral']} , 1 , 0]}
                },
                negativeCount : {
                    $sum : {$cond : [{$eq : ["$sentiment" , "negative"]} , 1 , 0]}
                },
                 avgResponseTime: {
                    $avg: {
                        $cond: [
                            '$isAcknowledged',
                            {
                                $divide: [
                                    { $subtract: ['$acknowledgedAt', '$createdAt'] },
                                    1000 * 60 * 60 * 24
                                ]
                            },
                            null
                        ]
                    }
                },
                latestFeedback: { $max: '$createdAt' },
                oldestFeedback: { $min: '$createdAt' },
                recentFeedback : {
                     $push: {
                        _id: '$_id',
                        sentiment: '$sentiment',
                        isAcknowledged: '$isAcknowledged',
                        createdAt: '$createdAt',
                        strengths: '$strengths',
                        areasToImprove: '$areasToImprove'
                    }
                }

            }
        },
        {
            $lookup : {
                from : "users",
                localField : "_id",
                foreignField : "_id",
                as : "managerInfo",
                pipeline : [
                    {
                        $project : {
                            name : 1,
                            email : 1,
                            userProfile : 1,
                        }
                    }
                ]
            }
        },
        {
            $addFields : {
                manager : { 
                    $arrayElemAt : ["$managerInfo" , 0],
                },
                acknowledgmentRate : {
                    $cond: [
                        { $gt: ['$feedbackCount', 0] },
                        { $multiply: [{ $divide: ['$acknowledgedCount', '$feedbackCount'] }, 100] },
                        0
                    ]
                },
                positiveRate : {
                    $cond: [
                        { $gt: ['$feedbackCount', 0] },
                        { $multiply: [{ $divide: ['$positiveCount', '$feedbackCount'] }, 100] },
                        0
                    ]
                },
                daysSinceLastFeedback : {
                     $divide: [
                        { $subtract: [new Date(), '$latestFeedback'] },
                        1000 * 60 * 60 * 24
                    ]
                },
                feedbackFrequency : {
                     $divide: [
                        '$feedbackCount',
                        {
                            $divide: [
                                { $subtract: ['$latestFeedback', '$oldestFeedback'] },
                                1000 * 60 * 60 * 24
                            ]
                        }
                    ]
                }
            }
        },
        {
            $project : {
                 manager: 1,
                feedbackCount: 1,
                acknowledgedCount: 1,
                acknowledgmentRate: { $round: ['$acknowledgmentRate', 1] },
                positiveCount: 1,
                neutralCount: 1,
                negativeCount: 1,
                positiveRate: { $round: ['$positiveRate', 1] },
                avgResponseTime: { $round: ['$avgResponseTime', 1] },
                latestFeedback: 1,
                daysSinceLastFeedback: { $round: ['$daysSinceLastFeedback', 1] },
                feedbackFrequency: { $round: ['$feedbackFrequency', 2] },
                recentFeedback: { $slice: ['$recentFeedback', -3] }
            }
        },
        {
            $sort: { feedbackCount: -1 }
        }
    ]);

    return {
        managerBreakdown : managerInsights,
        summary : {
            totalManagers : managerInsights.length,
            mostActiveManager : managerInsights[0] || null,
            averageFeedbackPerManager: managerInsights.length > 0 ? 
                Math.round((managerInsights.reduce((sum, m) => sum + m.feedbackCount, 0) / managerInsights.length) * 10) / 10 : 0,
            averageAcknowledgmentRate: managerInsights.length > 0 ? 
                Math.round((managerInsights.reduce((sum, m) => sum + m.acknowledgmentRate, 0) / managerInsights.length) * 10) / 10 : 0,
            averagePositiveRate: managerInsights.length > 0 ? 
                Math.round((managerInsights.reduce((sum, m) => sum + m.positiveRate, 0) / managerInsights.length) * 10) / 10 : 0
        }
    };
}

function generateRecommendations (feedbackOverview, performanceMetrics, acknowledgmentStats, goalProgress){
    const recommendations = [];

    if(goalProgress?.goals){
        goalProgress.goals.forEach(goal => {
            if(goal.status === 'needs_work'){
                recommendations.push({
                     type: 'goal',
                    priority: 'high',
                    title: `Focus on: ${goal.title}`,
                    message: `You're at ${goal.current}${goal.unit}, target is ${goal.target}${goal.unit}`,
                    actionItems: getGoalActionItems(goal.id)
                });
            }
        });
    }

    if(acknowledgmentStats?.overall?.acknowledgmentRate < 60){
        recommendations.push({
            type: 'acknowledgment',
            priority: 'high',
            title: 'Improve Feedback Acknowledgment',
            message: `Your acknowledgment rate is ${acknowledgmentStats.overall.acknowledgmentRate}%. Try to acknowledge feedback within 24-48 hours to show engagement.`,
            actionItems: [
                'Set up daily reminders to check for new feedback',
                'Acknowledge feedback even if you need time to fully process it',
                'Use the mobile app to quickly acknowledge on-the-go'
            ]
        });
    }

     if (acknowledgmentStats?.overall?.avgResponseTime > 5) {
        recommendations.push({
            type: 'response_time',
            priority: 'medium',
            title: 'Faster Response Time',
            message: `Your average response time is ${acknowledgmentStats.overall.avgResponseTime} days. Quicker responses show better engagement.`,
            actionItems: [
                'Enable push notifications for new feedback',
                'Schedule specific times for reviewing feedback',
                'Consider acknowledging first, then providing detailed responses later'
            ]
        });
    }

     if (performanceMetrics?.trends?.positiveRateChange < -10) {
        recommendations.push({
            type: 'performance',
            priority: 'high',
            title: 'Address Declining Feedback Sentiment',
            message: `Your positive feedback rate has decreased by ${Math.abs(performanceMetrics.trends.positiveRateChange)}%. Focus on areas mentioned in recent feedback.`,
            actionItems: [
                'Review recent feedback for common improvement areas',
                'Schedule a one-on-one with your manager to discuss concerns',
                'Create an action plan to address specific feedback points'
            ]
        });
    }

    if (feedbackOverview?.pendingFeedback > 3) {
        recommendations.push({
            type: 'engagement',
            priority: 'medium',
            title: 'Address Pending Feedback',
            message: `You have ${feedbackOverview.pendingFeedback} pending feedback items. Regular engagement shows professionalism.`,
            actionItems: [
                'Review and acknowledge the oldest pending feedback first',
                'Set aside 15 minutes daily for feedback review',
                'Ask managers for clarification if feedback is unclear'
            ]
        });
    }

     if (acknowledgmentStats?.overall?.acknowledgmentRate >= 80) {
        recommendations.push({
            type: 'positive',
            priority: 'low',
            title: 'Excellent Engagement!',
            message: `Great job maintaining an ${acknowledgmentStats.overall.acknowledgmentRate}% acknowledgment rate. Keep up the excellent engagement!`,
            actionItems: [
                'Continue your current feedback review routine',
                'Consider mentoring colleagues on feedback best practices',
                'Share your engagement strategies with the team'
            ]
        });
    }

     if (performanceMetrics?.currentPeriod?.totalFeedback === 0) {
        recommendations.push({
            type: 'feedback_seeking',
            priority: 'medium',
            title: 'Seek More Feedback',
            message: 'You haven\'t received feedback recently. Proactive feedback seeking can accelerate your growth.',
            actionItems: [
                'Schedule regular check-ins with your manager',
                'Ask for specific feedback on recent projects',
                'Request feedback from cross-functional partners'
            ]
        });
    }

    return recommendations.slice(0 , 5);
}

function getGoalActionItems(goalId) {
    const actionItems = {
        acknowledgment_rate: [
            'Set up push notifications for new feedback',
            'Review feedback daily at a set time',
            'Acknowledge immediately, respond thoughtfully later'
        ],
        response_time: [
            'Enable email notifications for feedback',
            'Set calendar reminders for feedback review',
            'Use mobile app for quick acknowledgments'
        ]
    };
    
    return actionItems[goalId] || [];
}

function calculatePercentile(employeeValue, teamAverage, lowerIsBetter = false) {
    if (employeeValue === 0 && teamAverage === 0) return 50;
    if (teamAverage === 0) return lowerIsBetter ? 0 : 100;
    
    const ratio = employeeValue / teamAverage;
    
    if (lowerIsBetter) {
      
        if (ratio <= 0.8) return 90;
        if (ratio <= 0.9) return 75;
        if (ratio <= 1.0) return 60;
        if (ratio <= 1.1) return 40;
        if (ratio <= 1.2) return 25;
        return 10;
    } else {
      
        if (ratio >= 1.2) return 90;
        if (ratio >= 1.1) return 75;
        if (ratio >= 1.0) return 60;
        if (ratio >= 0.9) return 40;
        if (ratio >= 0.8) return 25;
        return 10;
    }
}

function calculateTrendAnalysis (trends){
     if (trends.length < 2) {
        return {
            direction: 'stable',
            strength: 'weak',
            summary: 'Insufficient data for trend analysis'
        };
    }

    const recent = trends.slice(-3); // Last 3 months
    const older = trends.slice(0, -3); // Earlier months
    
    if (recent.length === 0 || older.length === 0) {
        return {
            direction: 'stable',
            strength: 'weak',
            summary: 'Insufficient data for trend analysis'
        };
    }

    const recentAvg = recent.reduce((sum, t) => sum + t.acknowledgmentRate, 0) / recent.length;
    const olderAvg = older.reduce((sum, t) => sum + t.acknowledgmentRate, 0) / older.length;
    
    const change = recentAvg - olderAvg;
    const changePercent = Math.abs(change);
    
    let direction = 'stable';
    let strength = 'weak';
    
    if (change > 5) direction = 'improving';
    else if (change < -5) direction = 'declining';
    
    if (changePercent > 15) strength = 'strong';
    else if (changePercent > 8) strength = 'moderate';
    
    return {
        direction,
        strength,
        change: Math.round(change * 10) / 10,
        summary: `${direction === 'improving' ? 'Improving' : direction === 'declining' ? 'Declining' : 'Stable'} trend with ${strength} ${changePercent > 5 ? 'momentum' : 'movement'}`
    };
}

function categorizeResponseTime(avgResponseTime) {
    if (!avgResponseTime) return 'unknown';
    if (avgResponseTime <= 1) return 'excellent';
    if (avgResponseTime <= 3) return 'good';
    if (avgResponseTime <= 7) return 'fair';
    return 'needs_improvement';
}

function calculateQuickHealthScore(acknowledgmentRate, positiveRate, avgResponseTime) {
    let score = 0;
    
    score += (acknowledgmentRate / 100) * 40;
    
    score += (positiveRate / 100) * 40;
    
    if (avgResponseTime !== null) {
        const responseScore = Math.max(0, 20 - (avgResponseTime * 2));
        score += Math.min(20, responseScore);
    }
    
    return Math.round(score);
}

function handlePromiseResults (results){
    return results.map((result , index)=>{
        if(result.status === "fulfilled"){
            return result.value;
        }else {
            console.warn(`Dashboard promise ${index} failed:`, result.reason?.message);
            return null;
        }
    })
};

function getTimeRangeDescription(days) {
    if (days === 1) return 'Today';
    if (days === 7) return 'Last week';
    if (days === 30) return 'Last month';
    if (days === 90) return 'Last quarter';
    if (days === 365) return 'Last year';
    return `Last ${days} days`;
}

function calculateFeedbackVelocity(feedbackOverview, daysBack) {
    if (!feedbackOverview || !feedbackOverview.totalFeedback) return 0;
    const weeks = Math.max(1, Math.ceil(daysBack / 7));
    return Math.round((feedbackOverview.totalFeedback / weeks) * 10) / 10;
}

function extractTopStrengths(feedbackHistory) {
    if (!feedbackHistory?.recentFeedback) return [];
    
    const strengthsText = feedbackHistory.recentFeedback
        .map(f => f.strengths)
        .filter(Boolean)
        .join(' ');
    
    const commonWords = strengthsText.toLowerCase()
        .split(/\W+/)
        .filter(word => word.length > 3)
        .reduce((acc, word) => {
            acc[word] = (acc[word] || 0) + 1;
            return acc;
        }, {});
    
    return Object.entries(commonWords)
        .sort(([,a], [,b]) => b - a)
        .slice(0, 5)
        .map(([word, count]) => ({ word, count }));
}

function getGoalStatus(current, target, lowerIsBetter = false) {
    if (!current) return 'no_data';
    
    const ratio = current / target;
    
    if (lowerIsBetter) {
        if (ratio <= 1) return 'achieved';
        if (ratio <= 1.5) return 'close';
        return 'needs_work';
    } else {
        if (ratio >= 1) return 'achieved';
        if (ratio >= 0.8) return 'close';
        return 'needs_work';
    }
}

function getHealthCategory(score) {
    if (score >= 85) return 'excellent';
    if (score >= 70) return 'good';
    if (score >= 55) return 'fair';
    return 'needs_attention';
}

function assessDataQuality(results) {
    const [feedbackOverview] = results;
    
    let quality = 'good';
    const issues = [];
    
    if (!feedbackOverview || feedbackOverview.totalFeedback === 0) {
        quality = 'limited';
        issues.push('No feedback data available');
    } else if (feedbackOverview.totalFeedback < 3) {
        quality = 'limited';
        issues.push('Limited feedback sample size');
    }
    
    return {
        level: quality,
        issues,
        score: issues.length === 0 ? 100 : Math.max(20, 100 - (issues.length * 30))
    };
}

function calculateEmployeeHealthScore(results) {
    const [feedbackOverview, , performanceMetrics, , , acknowledgmentStats] = results;
    
    let score = 0;
    let maxScore = 0;
    
    // Acknowledgment rate (30 points)
    if (acknowledgmentStats?.overall?.acknowledgmentRate !== undefined) {
        score += Math.min(30, (acknowledgmentStats.overall.acknowledgmentRate / 100) * 30);
        maxScore += 30;
    }
    
    // Response time (20 points)
    if (acknowledgmentStats?.overall?.avgResponseTime !== null && acknowledgmentStats?.overall?.avgResponseTime !== undefined) {
        const responseScore = Math.max(0, 20 - (acknowledgmentStats.overall.avgResponseTime * 2));
        score += Math.min(20, responseScore);
        maxScore += 20;
    }
    
    // Positive feedback rate (25 points)
    if (performanceMetrics?.currentPeriod?.positiveRate !== undefined) {
        score += Math.min(25, (performanceMetrics.currentPeriod.positiveRate / 100) * 25);
        maxScore += 25;
    }
    
    // Engagement (25 points)
    if (feedbackOverview?.totalFeedback !== undefined) {
        const engagementScore = Math.min(25, feedbackOverview.totalFeedback * 2);
        score += engagementScore;
        maxScore += 25;
    }
    
    const finalScore = maxScore > 0 ? Math.round((score / maxScore) * 100) : 0;
    
    return {
        score: finalScore,
        category: getHealthCategory(finalScore),
        breakdown: {
            acknowledgment: acknowledgmentStats?.overall?.acknowledgmentRate || 0,
            responsiveness: acknowledgmentStats?.overall?.avgResponseTime || null,
            positivity: performanceMetrics?.currentPeriod?.positiveRate || 0,
            engagement: feedbackOverview?.totalFeedback || 0
        }
    };
}

async function generateGoalProgress(employeeId, startDate) {
    try {
        // This would integrate with a goals/OKR system if available
        const goals = [
            {
                id: 'acknowledgment_rate',
                title: 'Maintain 80%+ Acknowledgment Rate',
                target: 80,
                current: null, // Will be filled from feedback data
                unit: '%',
                category: 'engagement'
            },
            {
                id: 'response_time',
                title: 'Respond to Feedback Within 48h',
                target: 2,
                current: null,
                unit: 'days',
                category: 'responsiveness'
            }
        ];

        // Get current performance data
        const performanceData = await Feedback.aggregate([
            {
                $match: {
                    toEmployeeId: new mongoose.Types.ObjectId(employeeId),
                    isDeleted: false,
                    createdAt: { $gte: startDate }
                }
            },
            {
                $group: {
                    _id: null,
                    totalFeedback: { $sum: 1 },
                    acknowledgedCount: { $sum: { $cond: ['$isAcknowledged', 1, 0] } },
                    avgResponseTime: {
                        $avg: {
                            $cond: [
                                '$isAcknowledged',
                                { $divide: [{ $subtract: ['$acknowledgedAt', '$createdAt'] }, 1000 * 60 * 60 * 24] },
                                null
                            ]
                        }
                    }
                }
            }
        ]);

        const data = performanceData[0];
        if (data) {
            goals[0].current = data.totalFeedback > 0 ? 
                Math.round((data.acknowledgedCount / data.totalFeedback) * 100) : 0;
            goals[1].current = data.avgResponseTime ? 
                Math.round(data.avgResponseTime * 10) / 10 : null;
        }

        return {
            goals: goals.map(goal => ({
                ...goal,
                progress: goal.current ? Math.min(100, (goal.current / goal.target) * 100) : 0,
                status: getGoalStatus(goal.current, goal.target, goal.id === 'response_time')
            })),
            overallProgress: goals.reduce((sum, goal) => {
                const progress = goal.current ? Math.min(100, (goal.current / goal.target) * 100) : 0;
                return sum + progress;
            }, 0) / goals.length
        };
        
    } catch (error) {
        console.warn('Failed to generate goal progress:', error.message);
        return null;
    }
}


export { getManagerTeams, generateFeedbackAnalytics, generateEmployeeMetrics, generateTeamOverview, generateRecentActivity, generatePerformanceInsights, getEmployeeTeamInfo, generateFeedbackOverview, generateFeedbackHistory, generatePerformanceMetrics, generateTeamComparison, generatePerformanceTrends, generateAcknowledgmentStats , generateManagerInsights , generateRecommendations , handlePromiseResults  , getTimeRangeDescription , calculateFeedbackVelocity , extractTopStrengths , getGoalStatus , getHealthCategory , assessDataQuality , calculateQuickHealthScore  , calculateEmployeeHealthScore , generateGoalProgress};