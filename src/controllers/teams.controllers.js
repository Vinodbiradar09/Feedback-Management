import { asyncHandler } from "../utils/asyncHandler.js";
import { ApiError } from "../utils/ApiError.js";
import { ApiResponse } from "../utils/ApiResponse.js";
import { User } from "../models/users.model.js";
import { Team } from "../models/teams.model.js";
import mongoose from "mongoose";
import e from "express";

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

const addTeamEmployees = asyncHandler(async (req, res) => {
    const { teamId } = req.params;
    const { employeeIds } = req.body;
    const requester = req.user;
    if (!employeeIds || !Array.isArray(employeeIds) || employeeIds.length === 0) {
        throw new ApiError(400, "At least one valid employee ID is required");
    }
    const uniqueIds = [...new Set(employeeIds)];
    const invalidFormatIds = uniqueIds.filter(id =>
        !mongoose.Types.ObjectId.isValid(id)
    );
    if (invalidFormatIds.length > 0) {
        throw new ApiError(400, `Invalid ID format: ${invalidFormatIds.join(', ')}`);
    }
    const team = await Team.findById(teamId);
    if (!team) {
        throw new ApiError(404, "Team not found");
    }
    const isAdmin = requester.role === "admin";
    const isTeamManager = team.managerId.equals(requester._id);
    if (!isAdmin && !isTeamManager) {
        throw new ApiError(403, "Unauthorized to modify this team");
    }
    const validEmployees = await User.find({
        _id: { $in: uniqueIds },
        role: "employee",
        isActive: true
    }).select('_id');
    const validIds = validEmployees.map(e => e._id.toString());
    const invalidEmployeeIds = uniqueIds.filter(id =>
        !validIds.includes(id)
    );
    if (invalidEmployeeIds.length > 0) {

        throw new ApiError(404,
            `The following IDs don't match active employees: ${invalidEmployeeIds.join(', ')}`
        );
    }
    const existingIds = team.employeeIds.map(id => id.toString());
    const newIds = validIds.filter(id =>
        !existingIds.includes(id)
    );
    if (newIds.length === 0) {
        throw new ApiError(400, "All employees already in team");
    }
    const updatedTeam = await Team.findByIdAndUpdate(
        teamId,
        { $addToSet: { employeeIds: { $each: newIds } } },
        { new: true, runValidators: true }
    ).populate({
        path: 'employeeIds',
        select: 'name email role',
        match: { isActive: true }
    });
    const sanitizedTeam = {
        _id: updatedTeam._id,
        teamName: updatedTeam.teamName,
        managerId: updatedTeam.managerId,
        employees: updatedTeam.employeeIds.map(e => ({
            _id: e._id,
            name: e.name,
            email: e.email,
            role: e.role
        })),
        employeeCount: updatedTeam.employeeIds.length
    };

    res.status(200).json(
        new ApiResponse(200, sanitizedTeam, "Employees added successfully")
    );
});

const removeEmployeeFromTeam = asyncHandler(async (req, res) => {
    const { teamId } = req.params;
    const { employeeIds } = req.body;
    const authorizedUser = req.user;
    if (!Array.isArray(employeeIds)) {
        throw new ApiError(400, "Employee IDs must be provided as an array");
    }
    if (employeeIds.length === 0) {
        throw new ApiError(400, "At least one employee ID is required");
    }
    if (!mongoose.Types.ObjectId.isValid(teamId)) {
        throw new ApiError(400, "Invalid team ID format");
    }
    const team = await Team.findById(teamId);
    if (!team) {
        throw new ApiError(404, "Team not found");
    }
    const isAdmin = authorizedUser.role === "admin";
    const isTeamManager = team.managerId.equals(authorizedUser._id);
    if (!isAdmin && !isTeamManager) {
        throw new ApiError(403, "Unauthorized: Only team manager or admin can remove employees");
    }

    const employeeObjectIds = employeeIds.filter(id =>
        mongoose.Types.ObjectId.isValid(id)
    ).map(id => new mongoose.Types.ObjectId(id));

    const uniqueIds = [... new Set(employeeObjectIds)];
    const employeesInTeam = team.employeeIds.filter(id =>
        uniqueIds.some(uids => id.equals(uids))
    )

    if (employeesInTeam.length !== uniqueIds.length) {
        const InvalidIds = uniqueIds.filter(id =>
            !team.employeeIds.some(e => e.equals(id))
        ).map(id => id.toString());
        throw new ApiError(400,
            `The following employees are not in this team: ${InvalidIds.join(', ')}`);
    }

    const updatedTeam = await Team.findByIdAndUpdate(teamId,
        {
            $pull: { employeeIds: { $in: employeesInTeam } }
        },
        {
            new: true, runValidators: true
        }
    ).populate({
        path: 'employeeIds',
        select: 'name email role isActive',
        options: { lean: true }
    });
    const fullEmployeeDocs = await User.find({ _id: { $in: employeesInTeam } })
        .select('name role isActive email');

    const removedEmployees = fullEmployeeDocs.map(e => ({
        _id: e._id,
        name: e.name,
        role: e.role,
        isActive: e.isActive,
        email: e.email
    }));
    const sanitizedTeam = {
        _id: updatedTeam._id,
        teamName: updatedTeam.teamName,
        manager: updatedTeam.managerId,
        employeeCount: updatedTeam.employeeIds.length,
        employees: updatedTeam.employeeIds.map(e => ({
            _id: e._id,
            name: e.name,
            isActive: e.isActive,
            email: e.email,
            role: e.role,
        }))
    };
    res.status(200).json(
        new ApiResponse(200, { sanitizedTeam, removedEmployees }, "Employees removed successfully")
    );
})

const getMyTeams = asyncHandler(async(req , res)=>{
    // first get the manager from the req.user , check it ;
    // now do the aggregation for it first match the manager id ,
    // now do lookup from the team , 
    // and get all the details of the team , 

    
})
export { createTeam, addTeamEmployees, removeEmployeeFromTeam };