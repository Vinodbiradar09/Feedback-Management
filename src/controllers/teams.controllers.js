import { asyncHandler } from "../utils/asyncHandler.js";
import { ApiError } from "../utils/ApiError.js";
import { ApiResponse } from "../utils/ApiResponse.js";
import { User } from "../models/users.model.js";
import { Team } from "../models/teams.model.js";

const createTeam = asyncHandler(async (req, res) => {
    const { teamName, managerId } = req.body;
    const authorizedUser = req.user;
    const cleanTeamName = teamName?.trim() || "";
    if (cleanTeamName.length < 2) {
        throw new ApiError(400, "Team name must be at least 2 characters long");
    }
    let resolvedManagerId;
    if (authorizedUser.role === "admin") {
        if (!managerId) {
            throw new ApiError(400, "Manager ID required for admin team creation");
        }
        const managerExists = await User.exists({
            _id: managerId,
            isActive: true,
            role: "manager",
        });
        if (!managerExists) throw new ApiError(404, "Active manager not found");
        resolvedManagerId = managerId;
    } else if (authorizedUser.role === "manager") {
        resolvedManagerId = authorizedUser._id;
    } else {
        throw new ApiError(403, "Only admins/managers can create teams");
    }
    const team = await Team.create({
        managerId: resolvedManagerId,
        teamName: teamName.trim(),
        employeeIds: [],
        isActive: true
    });
    res.status(201).json(new ApiResponse(201, team, "Successfully created the team"));
});

const addEmployeeToTeam = asyncHandler(async(req , res)=>{
    // first take the employee id's from the body , check if the employees came or not 
    // now check the employees , if they are valid or not and isActive or not also 
    // 
})


export { createTeam };