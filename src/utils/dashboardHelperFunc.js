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
                            role: 'employees'
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
                activeEmployeeCount: { $size: "$emloyees" },
                recentlyActiveCount: {
                    $size: {
                        $filter: {
                            input: "$emloyees",
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
                sentimentBreakdown: emp.sentiment.reduce((acc, sentiment) => {
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
    const totalEmployees = managerTeams.reduce((sum, team) => sum + team.activeEmployeeCount, 0);
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
        activities : recentActivities,
        totalActivities : recentActivities.length,
        timeRange: "Last 30 days"
    }
}

async function generatePerformanceInsights(allEmployeeIds, includeDetailed) {
    const performanceData = await Feedback.aggregate([
        {
            $match : {
                toEmployeeId : {$in : allEmployeeIds},
                isDeleted : false,
            }
        },
        {
            $group : {
                _id : "$toEmployeeId",
                totalFeedback : {$sum : 1},
                positiveFeedback : {
                    $sum : { $cond : [{ $eq : ["$sentiment" , "positive"]} , 1 , 0]}
                },
                acknowledgedCount : {
                    $sum : { $cond : ["$isAcknowledged" , 1 ,0]}
                },
                averageResponseTime : {
                    $avg : {
                        $cond : [
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
            $addFields : {
                positiveRatio : {
                    $cond : [
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
                        { $multiply: [
                            { $cond: [
                                { $gt: ["$totalFeedback", 0] },
                                { $divide: ["$positiveFeedback", "$totalFeedback"] },
                                0
                            ]}, 
                            0.6
                        ]},
                        { $multiply: [
                            { $cond: [
                                { $gt: ["$totalFeedback", 0] },
                                { $divide: ["$acknowledgedCount", "$totalFeedback"] },
                                0
                            ]}, 
                            0.4
                        ]}
                    ]
                }
            }
        },
        { $sort: { performanceScore: -1, totalFeedback: -1 } },
        { $limit: 5 }
    ]);

    let processedPerformanceData = performanceData;
    if(includeDetailed){
        const employeeIds = performanceData.map(emp => emp._id);
        const employees = await User.find({
            _id : {$in : employeeIds},
             role: 'employee'
        }).select("name email userProfile").lean();

        const employeeMap = employees.reduce((map , emp)=>{
            map[emp._id.toString()] = emp;
            return map;
        }, {});

        processedPerformanceData = performanceData.map(emp => {
            const employee = employeeMap[emp._id.toString()];
            return {
                employee : employee ? {
                    _id : employee._id,
                    name : employee.name,
                    email : employee.email,
                    userProfile : employee.userProfile,

                } : null,
                totalFeedback : emp.totalFeedback,
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
            employeeId : emp._id,
            totalFeedback : emp.totalFeedback,
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

export { getManagerTeams, generateFeedbackAnalytics, generateEmployeeMetrics , generateTeamOverview,generateRecentActivity , generatePerformanceInsights};