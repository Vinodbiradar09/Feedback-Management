import { asyncHandler } from "../utils/asyncHandler.js";
import { ApiError } from "../utils/ApiError.js";
import { ApiResponse } from "../utils/ApiResponse.js";
import { User } from "../models/users.model.js";
import { Team } from "../models/teams.model.js";
import { Feedback } from "../models/feedback.model.js";
import { Feedbackhistory } from "../models/feedbackHistory.model.js";
import NodeCache from "node-cache";
import { getManagerTeams, generateFeedbackAnalytics, generateEmployeeMetrics, generateRecentActivity, generatePerformanceInsights, generateTeamOverview, getEmployeeTeamInfo, generateFeedbackOverview, generateFeedbackHistory, generatePerformanceMetrics, generateTeamComparison, generatePerformanceTrends, generateAcknowledgmentStats , generateManagerInsights , handlePromiseResults , getTimeRangeDescription , calculateFeedbackVelocity , extractTopStrengths ,assessDataQuality , generateRecommendations , calculateEmployeeHealthScore , generateGoalProgress} from "../utils/dashboardHelperFunc.js";

const dashboardCache = new NodeCache({ stdTTL: 300, checkperiod: 60 });

const RECENT_ACTIVITY_LIMIT = 20;
const TOP_EMPLOYEES_LIMIT = 10;
const DAILY_TREND_DAYS = 30;

const getManagerDashboard = asyncHandler(async (req, res) => {
    const manager = req.user;
    const {
        timeRange = '30',
        includeDetailedStats = 'false',
        includeRecentActivity = 'true'
    } = req.query;

    if (!manager || manager.role !== "manager") {
        throw new ApiError(403, 'Only managers can access dashboard data');
    }

    if (!manager.isActive) {
        throw new ApiError(402, "Only Active managers can access the dashboard");
    }
    const cacheKey = `manager_dashboard_${manager._id}_${timeRange}_${includeDetailedStats}_${includeRecentActivity}`;
    const cachedData = dashboardCache.get(cacheKey);

    if (cachedData) {
        console.log(`Cache hit for manager dashboard: ${manager._id}`);
        return res.status(200).json(new ApiResponse(200, cachedData, 'Manager dashboard data retrieved successfully (cached)'));
    }

    console.log(`Cache miss for manager dashboard: ${manager._id}, generating fresh data...`);

    try {
        const managerTeams = await getManagerTeams(manager._id);

        if (!managerTeams || managerTeams.length === 0) {
            throw new ApiError(404, "No active teams found for this manager");
        }

        const now = new Date();
        const daysBack = parseInt(timeRange);
        const startDate = new Date(now.getTime() - (daysBack * 24 * 60 * 60 * 1000));

        const allEmployeeIds = managerTeams.flatMap(team => team.employeeIds);
        if (!allEmployeeIds || allEmployeeIds.length === 0) {
            throw new ApiError(400, "allEmployeeIds not found");
        }

        const [
            feedbackAnalytics,
            employeeMetrics,
            teamOverview,
            recentActivity,
            performanceInsights
        ] = await Promise.all([
            generateFeedbackAnalytics(manager._id, allEmployeeIds, startDate, daysBack, includeDetailedStats === 'true'),
            generateEmployeeMetrics(allEmployeeIds),
            generateTeamOverview(managerTeams),
            includeRecentActivity === 'true' ? generateRecentActivity(manager._id, allEmployeeIds) : Promise.resolve(null),
            generatePerformanceInsights(allEmployeeIds, includeDetailedStats === "true")
        ]);

        const responseData = {
            manager: {
                _id: manager._id,
                name: manager.name,
                email: manager.email,
                userProfile: manager.userProfile
            },
            timeRange: {
                days: daysBack,
                startDate: startDate.toISOString(),
                endDate: now.toISOString()
            },
            overview: {
                totalTeams: managerTeams.length,
                totalEmployees: allEmployeeIds.length,
                totalFeedback: feedbackAnalytics.summary.totalFeedback,
                acknowledgedFeedback: feedbackAnalytics.summary.acknowledgedFeedback,
                pendingFeedback: feedbackAnalytics.summary.pendingFeedback,
                acknowledgmentRate: feedbackAnalytics.summary.acknowledgmentRate,
                avgResponseTimeDays: feedbackAnalytics.summary.averageResponseTime
            },
            teamOverview,
            employeeMetrics,
            feedbackAnalytics,
            ...(recentActivity && { recentActivity }),
            performanceInsights,
            metadata: {
                lastUpdated: new Date().toISOString(),
                cacheKey,
                includeDetailedStats: includeDetailedStats === 'true',
                includeRecentActivity: includeRecentActivity === 'true'
            }
        };

        dashboardCache.set(cacheKey, responseData);
        console.log(`Dashboard data cached for manager: ${manager._id}`);

        res.status(200).json(
            new ApiResponse(200, responseData, 'Manager dashboard data retrieved successfully')
        );
    } catch (error) {
        console.error('Manager dashboard error:', {
            managerId: manager._id,
            email: manager.email,
            error: error.message,
            stack: error.stack,
            timestamp: new Date().toISOString()
        });
        if (error instanceof ApiError) {
            throw error;
        }

        throw new ApiError(500, 'Failed to retrieve dashboard data. Please try again later.');
    }
});

const employeeDashboardCache = new NodeCache({ stdTTL: 180, checkperiod: 30 });

const CONFIG = {
    RECENT_FEEDBACK_LIMIT: 15,
    FEEDBACK_HISTORY_DAYS: 90,
    PERFORMANCE_TREND_MONTHS: 6,
    CACHE_TTL: 180,
    MAX_TIME_RANGE_DAYS: 365,
    DEFAULT_TIME_RANGE: 30
};

const getEmployeeDashboard = asyncHandler(async (req, res) => {
    const {
        timeRange = CONFIG.DEFAULT_TIME_RANGE.toString(),
        includeFeedbackHistory = 'true',
        includeTeamComparison = 'false',
        includePerformanceTrends = 'true'
    } = req.query;

    const employee = req.user;

    if (!employee || employee.role !== "employee") {
        throw new ApiError(400, "Only employees can access the employees dashboard data");
    }

    if (!employee.isActive) {
        throw new ApiError(400, "The employee must be active to access the dashboard");
    }
    const daysBack = parseInt(timeRange);
    if (isNaN(daysBack) || daysBack < 1 || daysBack > CONFIG.MAX_TIME_RANGE_DAYS) {
        throw new ApiError(400, `Time range must be between 1 and ${CONFIG.MAX_TIME_RANGE_DAYS} days`);
    }
    const cacheKey = `employee_dashboard_${employee._id}_${timeRange}_${includeFeedbackHistory}_${includeTeamComparison}_${includePerformanceTrends}`;
    const cachedData = employeeDashboardCache.get(cacheKey);

    if (cachedData) {
        console.log(`Cache hit for employee dashboard: ${employee._id}`);

        return res.status(200).json(new ApiResponse(200, cachedData, 'Employee dashboard data retrieved successfully (cached)'));
    }

    console.log(`Cache miss for employee dashboard: ${employee._id}, generating fresh data...`);

    try {

        const now = new Date();
        const startDate = new Date(now.getTime() - (daysBack * 24 * 60 * 60 * 1000));

        const employeeTeam = await getEmployeeTeamInfo(employee._id);
        const [
            feedbackOverview,
            feedbackHistory,
            performanceMetrics,
            teamComparison,
            performanceTrends,
            acknowledgmentStats,
            managerInsights,
            goalProgress
        ] = await Promise.allSettled([
            generateFeedbackOverview(employee._id, startDate, daysBack),
            includeFeedbackHistory === 'true' ?
                generateFeedbackHistory(employee._id, CONFIG.FEEDBACK_HISTORY_DAYS) :
                Promise.resolve(null),
            generatePerformanceMetrics(employee._id, startDate),
            includeTeamComparison === 'true' && employeeTeam ?
                generateTeamComparison(employee._id, employeeTeam._id, startDate) :
                Promise.resolve(null),
            includePerformanceTrends === 'true' ?
                generatePerformanceTrends(employee._id, CONFIG.PERFORMANCE_TREND_MONTHS) :
                Promise.resolve(null),
            generateAcknowledgmentStats(employee._id, startDate),
            generateManagerInsights(employee._id, startDate),
            generateGoalProgress(employee._id, startDate)
        ]);

         const results = handlePromiseResults([
            feedbackOverview,
            feedbackHistory,
            performanceMetrics,
            teamComparison,
            performanceTrends,
            acknowledgmentStats,
            managerInsights,
            goalProgress
        ]);

        const responseData = {
            employee: {
                _id: employee._id,
                name: employee.name,
                email: employee.email,
                userProfile: employee.userProfile,
                lastLogin: employee.lastLogin
            },
            team: employeeTeam,
            timeRange: {
                days: daysBack,
                startDate: startDate.toISOString(),
                endDate: now.toISOString(),
                description: getTimeRangeDescription(daysBack)
            },
            overview: {
                totalFeedbackReceived: results[0]?.totalFeedback || 0,
                acknowledgedFeedback: results[0]?.acknowledgedFeedback || 0,
                pendingFeedback: results[0]?.pendingFeedback || 0,
                acknowledgmentRate: results[0]?.acknowledgmentRate || 0,
                averageResponseTime: results[0]?.averageResponseTime || null,
                recentFeedbackCount: results[0]?.recentFeedbackCount || 0,
                feedbackVelocity: calculateFeedbackVelocity(results[0], daysBack) // New metric
            },
            feedbackAnalytics: {
                sentimentDistribution: results[0]?.sentimentDistribution || {},
                dailyTrend: results[0]?.dailyTrend || [],
                monthlyTrend: results[0]?.monthlyTrend || [],
                managerFeedbackBreakdown: results[0]?.managerBreakdown || [],
                topStrengths: extractTopStrengths(results[1]) // New feature
            },
            performanceMetrics: results[2] || {},
            acknowledgmentStats: results[5] || {},
            managerInsights: results[6] || {},
            goalProgress: results[7] || null, // New feature
            ...(results[1] && { feedbackHistory: results[1] }),
            ...(results[3] && { teamComparison: results[3] }),
            ...(results[4] && { performanceTrends: results[4] }),
            recommendations: generateRecommendations(results[0], results[2], results[5], results[7]),
            healthScore: calculateEmployeeHealthScore(results), // New feature
            metadata: {
                lastUpdated: new Date().toISOString(),
                cacheKey,
                includeFeedbackHistory: includeFeedbackHistory === 'true',
                includeTeamComparison: includeTeamComparison === 'true',
                includePerformanceTrends: includePerformanceTrends === 'true',
                dataQuality: assessDataQuality(results), // New feature
                version: '2.0'
            }
        };

        try {
            employeeDashboardCache.set(cacheKey, responseData);
            console.log(`Employee dashboard data cached for employee: ${employee._id}`);
        } catch (cacheError) {
            console.warn('Failed to cache dashboard data:', cacheError.message);
        }

         res.status(200).json(
            new ApiResponse(200, responseData, 'Employee dashboard data retrieved successfully')
        );

    } catch (error) {
        console.error('Employee dashboard error:', {
            employeeId: employee._id,
            email: employee.email,
            error: error.message,
            stack: error.stack,
            timestamp: new Date().toISOString(),
            timeRange: daysBack
        });

        if (error instanceof ApiError) {
            throw error;
        }

        throw new ApiError(500, 'Failed to retrieve dashboard data. Please try again later.');
    }
});



export { getManagerDashboard, getEmployeeDashboard };