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
    if (team.isActive !== true) {
        throw new ApiError(401, "You cant add the employee team , because it is inActive");
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

const getMyTeams = asyncHandler(async (req, res) => {
    const teamManager = req.user;

    if (!teamManager || teamManager.role !== "manager") {
        throw new ApiError(403, "Unauthorized access: Only managers can access");
    }

    try {

        const managerObjectId = new mongoose.Types.ObjectId(teamManager._id);


        const page = Math.max(1, parseInt(req.query.page) || 1);
        const limit = Math.min(100, Math.max(1, parseInt(req.query.limit) || 10));
        const skip = (page - 1) * limit;

        const aggregationPipeline = [
            {
                $match: {
                    managerId: managerObjectId,
                    isActive: true
                }
            },
            {
                $lookup: {
                    from: "users",
                    localField: "managerId",
                    foreignField: "_id",
                    as: "managerDetails",
                    pipeline: [
                        {
                            $project: {
                                _id: 1,
                                name: 1,
                                email: 1,
                                role: 1,
                                userProfile: 1,
                            }
                        }
                    ]
                }
            },
            {
                $lookup: {
                    from: "users",
                    localField: "employeeIds",
                    foreignField: "_id",
                    as: "employeesDetails",
                    pipeline: [
                        {
                            $project: {
                                _id: 1,
                                name: 1,
                                email: 1,
                                role: 1,
                                userProfile: 1,
                                isActive: 1
                            }
                        }
                    ]
                }
            },
            {
                $addFields: {
                    manager: { $arrayElemAt: ["$managerDetails", 0] },
                    employees: "$employeesDetails",
                    totalEmployees: { $size: "$employeesDetails" },
                    activeEmployees: {
                        $size: {
                            $filter: {
                                input: "$employeesDetails",
                                cond: { $eq: ["$$this.isActive", true] }
                            }
                        }
                    }
                }
            },
            {
                $project: {
                    _id: 1,
                    teamName: 1,
                    isActive: 1,
                    createdAt: 1,
                    manager: 1,
                    employees: 1,
                    totalEmployees: 1,
                    activeEmployees: 1,

                }
            },
            {
                $sort: { createdAt: -1 }
            }
        ];


        aggregationPipeline.push(
            { $skip: skip },
            { $limit: limit }
        );


        const [paginatedResult, totalCountResult] = await Promise.all([
            Team.aggregate(aggregationPipeline),
            Team.countDocuments({
                managerId: managerObjectId,
                isActive: true
            })
        ]);

        if (!paginatedResult || paginatedResult.length === 0) {
            return res.status(200).json(
                new ApiResponse(200, {
                    teams: [],
                    pagination: {
                        currentPage: page,
                        totalPages: 0,
                        totalTeams: 0,
                        hasNextPage: false,
                        hasPrevPage: false
                    }
                }, "No teams found for this manager")
            );
        }

        const totalTeams = totalCountResult;
        const totalPages = Math.ceil(totalTeams / limit);
        const hasNextPage = page < totalPages;
        const hasPrevPage = page > 1;

        res.status(200).json(
            new ApiResponse(200, {
                teams: paginatedResult,
                pagination: {
                    currentPage: page,
                    totalPages,
                    totalTeams,
                    hasNextPage,
                    hasPrevPage
                }
            }, "Successfully retrieved manager's teams")
        );

    } catch (error) {
        console.error('Error in getMyTeams:', error);
        throw new ApiError(500, "Failed to retrieve teams");
    }
});

const getTeamDetailsById = asyncHandler(async (req, res) => {
    const { teamId } = req.params;
    const authorizedUser = req.user;

    if (!teamId || !mongoose.Types.ObjectId.isValid(teamId)) {
        throw new ApiError(403, "Invalid Id format , teamId is required to get the details of team id");
    }
    if (!["admin", "manager"].includes(authorizedUser.role)) {
        throw new ApiError(403, "Unauthorized access: Only managers and admins can access team details");
    }
    const page = Math.max(1, parseInt(req.query.page) || 1);
    const limit = Math.min(100, Math.max(1, parseInt(req.query.limit) || 10));
    const skip = (page - 1) * limit;

    const result = await Team.aggregate([
        {
            $match: {
                _id: new mongoose.Types.ObjectId(teamId),
                isActive: true,
            }
        },
        {
            $lookup: {
                from: "users",
                localField: "managerId",
                foreignField: "_id",
                as: "managerDetails",
                pipeline: [
                    {
                        $project: {
                            name: 1,
                            email: 1,
                            isActive: 1,
                            userProfile: 1,
                            role: 1,
                        }
                    }
                ]
            }
        },
        {
            $lookup: {
                from: "users",
                localField: "employeeIds",
                foreignField: "_id",
                as: "employeeDetails",
                pipeline: [
                    {
                        $project: {
                            name: 1,
                            email: 1,
                            isActive: 1,
                            userProfile: 1,
                            role: 1
                        }
                    },
                    { $skip: skip },
                    { $limit: limit }
                ]
            }
        },
        {
            $addFields: {
                manager: { $arrayElemAt: ["$managerDetails", 0] },
                employees: "$employeeDetails",
                totalEmployees: { $size: "$employeeIds" }, // Use original IDs
                activeEmployees: {
                    $size: {
                        $filter: {
                            input: "$employeeIds",
                            as: "empId",
                            cond: {
                                $let: {
                                    vars: {
                                        employee: {
                                            $arrayElemAt: [
                                                {
                                                    $filter: {
                                                        input: "$employeeDetails",
                                                        as: "ed",
                                                        cond: { $eq: ["$$ed._id", "$$empId"] }
                                                    }
                                                },
                                                0
                                            ]
                                        }
                                    },
                                    in: "$$employee.isActive"
                                }
                            }
                        }
                    }
                }
            }
        },
        {
            $project: {
                teamName: 1,
                isActive: 1,
                manager: 1,
                employees: 1,
                totalEmployees: 1,
                activeEmployees: 1,
            }
        },

    ])

    if (!result || result.length === 0) {
        return res.status(404).json(
            new ApiResponse(404, null, "Team not found or not active")
        );
    }

    const team = result[0];
    const totalEmployees = team.totalEmployees;
    const totalPages = Math.ceil(totalEmployees / limit);
    const hasNextPage = page < totalPages;
    const hasPrevPage = page > 1;

    if (authorizedUser.role === "manager" &&
        !team.manager._id.equals(authorizedUser._id)) {
        throw new ApiError(403, "Unauthorized: You don't manage this team");
    }
    res.status(200).json(
        new ApiResponse(200, {
            team,
            pagination: {
                currentPage: page,
                totalPages,
                totalEmployees,
                hasNextPage,
                hasPrevPage
            }
        }, "Team details retrieved successfully")
    );

})

const updateTeamDetails = asyncHandler(async (req, res) => {
    const { teamName } = req.body;
    const { teamId } = req.params;
    const authorizedUser = req.user;

    if (!teamName && teamName === undefined && teamName === null) {
        throw new ApiError(401, "Team name is required to update the team details");
    }
    if (!teamId || !mongoose.Types.ObjectId.isValid(teamId)) {
        throw new ApiError(401, "team id is required to update the team details");
    }
    if (!["admin", "manager"].includes(authorizedUser.role)) {
        throw new ApiError(403, "Unauthorized access: Only managers and admins can change team details");
    }
    if (authorizedUser.role === "manager" && authorizedUser.isActive === false) {
        throw new ApiError(401, "Hey manager you are unactive , u are not able to change the team name");
    }
    const team = await Team.findById(teamId);
    if (!team || team.isActive !== true) {
        throw new ApiError(404, "Team not found , or it is inActive");
    }
    const validManager = team.managerId.equals(authorizedUser._id);
    if (authorizedUser.role === "manager" && !validManager) {
        throw new ApiError(404, "You don't belongs to this team as a team manager ");
    }

    const updatedTeam = await Team.findByIdAndUpdate(teamId, {
        $set: {
            teamName,
            isActive: true,
        }
    },
        {
            new: true,
            runValidators: true
        }
    )

    if (!updatedTeam) {
        throw new ApiError(404, "failed to update the team details")
    }
    res.status(200).json(new ApiResponse(200, updatedTeam, "Team details updated successfully"));
})

const softDeleteTeam = asyncHandler(async (req, res) => {
    const { teamId } = req.params;
    const authorizedUser = req.user;

    if (!teamId || !mongoose.Types.ObjectId.isValid(teamId)) {
        throw new ApiError(401, "Invalid Team Id format");
    }
    if (!["admin", "manager"].includes(authorizedUser.role)) {
        throw new ApiError(404, "Unauthorized access only admins and managers have access to soft delete the team");
    }
    const team = await Team.findById(teamId);
    if (!team) {
        throw new ApiError(404, "No team found ");
    }
    if (team.isActive === false) {
        throw new ApiError(401, "The team already soft deleted you can't delete again");
    }
    if (authorizedUser.role === "manager" && !team.managerId.equals(authorizedUser._id)) {
        throw new ApiError(404, "You are not manager for this team , so u can't soft delete the team");
    }

    const updatedTeam = await Team.findByIdAndUpdate(teamId, {
        $set: {
            isActive: false,
        }
    },
        {
            new: true,
            runValidators: true,
        })

    if (!updatedTeam) {
        throw new ApiError(404, "failed to soft delete the team");
    }

    res.status(200).json(new ApiResponse(200, updatedTeam, "Successfully soft deleted the team"));
})

const makeIsActiveForTeam = asyncHandler(async (req, res) => {
    const { teamId } = req.params;
    const authorizedUser = req.user;

    if (!teamId || !mongoose.Types.ObjectId.isValid(teamId)) {
        throw new ApiError(401, "Invalid Team Id format");
    }
    if (!["admin", "manager"].includes(authorizedUser.role)) {
        throw new ApiError(402, "Unauthorized access / only admins and managers have the right");
    }
    const team = await Team.findById(teamId);
    if (!team) {
        throw new ApiError(404, "No team found");
    }
    if (team.isActive === true) {
        throw new ApiError(403, "The team is already active you can't overwritte it again");
    }
    if (authorizedUser.role === "manager" && !team.managerId.equals(authorizedUser._id)) {
        throw new ApiError(404, "You are not manager for this team , so u can't active the team ");
    }
    const updatedTeam = await Team.findByIdAndUpdate(teamId, {
        $set: {
            isActive: true,
        }
    },
        {
            new: true,
            runValidators: true,
        }
    )
    if (!updatedTeam) {
        throw new ApiError(404 , "Failed to active the team");
    }

    res.status(200).json(new ApiResponse(200 , updatedTeam , "Successfully activated the team"));
})

const getTeamMembers = asyncHandler(async(req , res)=>{
    // so get the teamId from the params , check it 
    // only managers and admins can perform this action 
    // the logic for it is simple , if the admin want to access this then in team members include manager also 
    // if not means only give the details of the employees and the team name and isActive

    
})


export { createTeam, addTeamEmployees, removeEmployeeFromTeam, getMyTeams, getTeamDetailsById, updateTeamDetails, softDeleteTeam , makeIsActiveForTeam};