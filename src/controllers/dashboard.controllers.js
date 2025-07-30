import { asyncHandler } from "../utils/asyncHandler.js";
import { ApiError } from "../utils/ApiError.js";
import { ApiResponse } from "../utils/ApiResponse.js";
import { User } from "../models/users.model.js";
import { Team } from "../models/teams.model.js";
import { Feedback } from "../models/feedback.model.js";
import { Feedbackhistory } from "../models/feedbackHistory.model.js";
import NodeCache from "node-cache";
import { getManagerTeams , generateFeedbackAnalytics , generateEmployeeMetrics , generateRecentActivity , generatePerformanceInsights , generateTeamOverview} from "../utils/dashboardHelperFunc.js";

const dashboardCache = new NodeCache ({stdTTL : 300 , checkperiod : 60});

const RECENT_ACTIVITY_LIMIT = 20;
const TOP_EMPLOYEES_LIMIT = 10;
const DAILY_TREND_DAYS = 30;

const getManagerDashboard = asyncHandler(async(req , res)=>{
    const manager = req.user;
    const { 
        timeRange = '30', 
        includeDetailedStats = 'false',
        includeRecentActivity = 'true' 
    } = req.query;

    if(!manager || manager.role !== "manager"){
        throw new ApiError(403, 'Only managers can access dashboard data');
    }

    if(!manager.isActive){
        throw new ApiError(402 , "Only Active managers can access the dashboard");
    }
    const cacheKey = `manager_dashboard_${manager._id}_${timeRange}_${includeDetailedStats}_${includeRecentActivity}`;
    const cachedData = dashboardCache.get(cacheKey);

    if(cachedData){
        console.log(`Cache hit for manager dashboard: ${manager._id}`);
        return res.status(200).json(new ApiResponse(200 , cachedData , 'Manager dashboard data retrieved successfully (cached)'));
    }

    console.log(`Cache miss for manager dashboard: ${manager._id}, generating fresh data...`);

    try {
       const managerTeams = await getManagerTeams(manager._id);
       
       if(!managerTeams || managerTeams.length === 0){
         throw new ApiError(404, "No active teams found for this manager");
       }

        const now = new Date();
        const daysBack = parseInt(timeRange);
        const startDate = new Date(now.getTime() - (daysBack * 24 * 60 * 60 * 1000));

        const allEmployeeIds = managerTeams.flatMap(team => team.employeeIds);
        if(!allEmployeeIds || allEmployeeIds.length === 0){
            throw new ApiError(400 , "allEmployeeIds not found");
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
            includeRecentActivity === 'true' ? generateRecentActivity(manager._id , allEmployeeIds) : Promise.resolve(null),
            generatePerformanceInsights(allEmployeeIds , includeDetailedStats === "true")
        ]);

        const responseData = {
            manager : {
                _id : manager._id,
                name : manager.name,
                email : manager.email,
                userProfile : manager.userProfile
            },
             timeRange: {
                days: daysBack,
                startDate: startDate.toISOString(),
                endDate: now.toISOString()
            },
            overview : {
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
            ...(recentActivity && {recentActivity}),
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

const getEmployeeDashboard = asyncHandler(async(req , res)=>{

})

export {getManagerDashboard , getEmployeeDashboard};