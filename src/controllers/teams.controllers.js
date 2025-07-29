import { asyncHandler } from "../utils/asyncHandler.js";
import { ApiError } from "../utils/ApiError.js";
import { ApiResponse } from "../utils/ApiResponse.js";
import { User } from "../models/users.model.js";
import { Team } from "../models/teams.model.js";
import mongoose from "mongoose";
import { NIL, v4 as uuidv4 } from "uuid";

const MAX_BATCH_SIZE = 100;
const TRANSACTION_TIMEOUT = 30000;
const MAX_RETRY_ATTEMPTS = 3;

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
        throw new ApiError(404, "Failed to active the team");
    }

    res.status(200).json(new ApiResponse(200, updatedTeam, "Successfully activated the team"));
})

const getTeamMembers = asyncHandler(async (req, res) => {
    const { teamId } = req.params;
    const authorizedUser = req.user;

    if (!teamId || !mongoose.Types.ObjectId.isValid(teamId)) {
        throw new ApiError(401, "Invalid Team Id format");
    }
    if (!["manager", "admin"].includes(authorizedUser.role)) {
        throw new ApiError(403, "Unauthorized: Only admins and managers can access team members");
    }
    const page = Math.max(1, parseInt(req.query.page) || 1);
    const limit = Math.min(100, Math.max(1, parseInt(req.query.limit) || 10));
    const skip = (page - 1) * limit;

    const team = await Team.findOne({
        _id: teamId,
        isActive: true,
    }).select("managerId employeeIds")

    if (!team) {
        throw new ApiError(404, "Team Not found");
    }
    if (authorizedUser.role === "manager" && !team.managerId.equals(authorizedUser._id)) {
        throw new ApiError(403, "Unauthorized: You don't manage this team");
    }
    const memberIds = authorizedUser.role === "admin" ? [...team.employeeIds, team.managerId] : team.employeeIds;
    const totalMembers = memberIds.length;

    const members = await User.aggregate([
        {
            $match: {
                _id: { $in: memberIds },
                isActive: true,
            }
        },
        {
            $project: {
                _id: 1,
                name: 1,
                email: 1,
                role: 1,
                userProfile: 1,
                isActive: 1
            }
        },
        { $skip: skip },
        { $limit: limit },
        {
            $addFields: {
                isManager: { $eq: ["$_id", team.managerId] }
            }
        },
        {
            $sort: {
                isManager: -1,  // Managers first
                name: 1
            }
        }

    ])

    if (!members || members.length === 0) {
        throw new ApiError(404, "failed to get the members of the team");
    }

    const response = {
        teamId: team._id,
        teamName: team.teamName,
        members,
        pagination: {
            currentPage: page,
            totalPages: Math.ceil(totalMembers / limit),
            totalMembers,
            hasNextPage: page < Math.ceil(totalMembers / limit),
            hasPrevPage: page > 1
        }
    };

    res.status(200).json(
        new ApiResponse(200, response, "Team members retrieved successfully")
    );

})

const transferEmployee = asyncHandler(async (req, res) => {
    const { transfers } = req.body;
    const adminId = req.user._id;
    const batchId = uuidv4();
    validateTransferInput(transfers);

    await validateAdminPermission(adminId);

    const validationResult = await validateTransfersWithAggregation(transfers);

    const result = await executeOptimizedTransferWithRetry(
        validationResult.transferGroups,
        adminId,
        batchId,
        validationResult.metadata
    );

    return res.status(200).json(
        new ApiResponse(200, result, "Employee transfers completed successfully")
    );
});

function validateTransferInput(transfers) {
    if (!Array.isArray(transfers) || transfers.length === 0) {
        throw new ApiError(400, "Transfer array is required and cannot be empty");
    }
    if (transfers.length > MAX_BATCH_SIZE) {
        throw new ApiError(400, `Batch size cannot exceed ${MAX_BATCH_SIZE} transfers`);
    }
    const requiredFields = ['employeeId', 'sourceTeamId', 'destinationTeamId'];
    transfers.forEach((transfer, index) => {
        requiredFields.forEach(field => {
            if (!transfer[field] || !mongoose.isValidObjectId(transfer[field])) {
                throw new ApiError(400, `Invalid ${field} at index ${index}`);
            }
        });

        if (transfer.sourceTeamId === transfer.destinationTeamId) {
            throw new ApiError(400, `Source and destination teams cannot be same at index ${index}`);
        }
    });
    const employeeIds = transfers.map(t => t.employeeId);
    const duplicates = employeeIds.filter((id, index) => employeeIds.indexOf(id) !== index);
    if (duplicates.length > 0) {
        throw new ApiError(400, `Duplicate employee transfers found: ${duplicates.join(', ')}`);
    }
}

async function validateAdminPermission(adminId) {
    const admin = await User.findById(adminId).select('role').lean();

    if (!admin || admin.role !== "admin") {
        throw new ApiError(403, "Only administrators can perform employee transfers");
    }
}
async function validateTransfersWithAggregation(transfers) {
    const employeeIds = [...new Set(transfers.map(t => new mongoose.Types.ObjectId(t.employeeId)))];
    const sourceTeamIds = [...new Set(transfers.map(t => new mongoose.Types.ObjectId(t.sourceTeamId)))];
    const destinationTeamIds = [...new Set(transfers.map(t => new mongoose.Types.ObjectId(t.destinationTeamId)))];
    const allTeamIds = [...new Set([...sourceTeamIds, ...destinationTeamIds])];

    const validationPipeline = [
        {
            $match: {
                _id: { $in: allTeamIds },
                isActive: true,
            }
        },
        {
            $addFields: {
                isSourceTeam: { $in: ["$_id", sourceTeamIds] },
                isDestinationTeam: { $in: ["$_id", destinationTeamIds] },
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
                            role: "employee",
                            isActive: true,
                        }
                    },
                    {
                        $project: {
                            _id: 1,
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
                employeeMap: {
                    $arrayToObject: {
                        $map: {
                            input: "$employees",  // Fixed: added $ prefix
                            as: "emp",
                            in: {
                                k: { $toString: "$$emp._id" },
                                v: "$$emp",
                            }
                        }
                    }
                },
                employeeIdStrings: {  // Fixed: moved inside the same $addFields
                    $map: {
                        input: "$employeeIds",
                        as: "id",
                        in: { $toString: "$$id" },
                    }
                }
            }
        },
        {
            $group: {
                _id: null,
                teams: {
                    $push: {
                        _id: "$_id",
                        teamName: "$teamName",
                        managerId: "$managerId",
                        employeeIds: "$employeeIds",
                        employeeIdStrings: "$employeeIdStrings",
                        employees: "$employees",
                        employeeMap: "$employeeMap",
                        isSourceTeam: "$isSourceTeam",
                        isDestinationTeam: "$isDestinationTeam",
                    }
                },
                sourceTeams: {
                    $push: {
                        $cond: [
                            "$isSourceTeam",
                            {
                                _id: "$_id",
                                teamName: "$teamName",
                                employeeIdStrings: "$employeeIdStrings",
                                employeeMap: "$employeeMap"  // Added for destination validation
                            },
                            null
                        ]
                    }
                },
                destinationTeams: {
                    $push: {
                        $cond: [
                            "$isDestinationTeam",
                            {
                                _id: "$_id",
                                teamName: "$teamName",
                                employeeIdStrings: "$employeeIdStrings",
                                employeeMap: "$employeeMap"  // Added for consistency
                            },
                            null
                        ]
                    }
                }
            }
        },
        {
            $project: {
                teams: 1,
                sourceTeams: {
                    $filter: {
                        input: "$sourceTeams",
                        cond: { $ne: ["$$this", null] }
                    }
                },
                destinationTeams: {
                    $filter: {
                        input: "$destinationTeams",
                        cond: { $ne: ["$$this", null] }
                    }
                }
            }
        }
    ];

    const [validationData] = await Team.aggregate(validationPipeline);

    if (!validationData) {
        throw new ApiError(404, "No valid teams found");
    }

    const teamMap = new Map(validationData.teams.map(team => [team._id.toString(), team]));
    const sourceTeamMap = new Map(validationData.sourceTeams.map(team => [team._id.toString(), team]));
    const destinationTeamMap = new Map(validationData.destinationTeams.map(team => [team._id.toString(), team]));
    
    const missingSourceTeams = sourceTeamIds.filter(id => !sourceTeamMap.has(id.toString()));
    const missingDestinationTeams = destinationTeamIds.filter(id => !destinationTeamMap.has(id.toString()));

    if (missingSourceTeams.length > 0) {
        throw new ApiError(404, `Source teams not found or inactive: ${missingSourceTeams.join(', ')}`);
    }
    if (missingDestinationTeams.length > 0) {
        throw new ApiError(404, `Destination teams not found or inactive: ${missingDestinationTeams.join(', ')}`);
    }

    const validationErrors = [];
    const validatedTransfers = [];

    transfers.forEach((transfer) => {
        const sourceTeam = sourceTeamMap.get(transfer.sourceTeamId);
        const destinationTeam = destinationTeamMap.get(transfer.destinationTeamId);
        const employeeIdStr = transfer.employeeId;

        // Check if employee exists in source team
        if (!sourceTeam.employeeIdStrings.includes(employeeIdStr)) {
            const employeeName = sourceTeam.employeeMap?.[employeeIdStr]?.name || "Unknown";
            validationErrors.push(`Employee ${employeeName} (${employeeIdStr}) does not belong to source team ${sourceTeam.teamName}`);
            return;
        }

        // Check if employee is active in source team
        if (!sourceTeam.employeeMap?.[employeeIdStr]) {
            validationErrors.push(`Employee (${employeeIdStr}) is in source team ${sourceTeam.teamName} but is inactive`);
            return;
        }

        // Check if employee is already in destination team
        if (destinationTeam.employeeIdStrings.includes(employeeIdStr)) {
            // Get name from destination if available, otherwise from source
            const employeeName = destinationTeam.employeeMap?.[employeeIdStr]?.name || 
                                sourceTeam.employeeMap?.[employeeIdStr]?.name || 
                                "Unknown";
            validationErrors.push(`Employee ${employeeName} is already in destination team ${destinationTeam.teamName}`);
            return;
        }

        validatedTransfers.push(transfer);
    });

    if (validationErrors.length > 0) {
        throw new ApiError(400, `Transfer validation failed:\n${validationErrors.join('\n')}`);
    }

    const transferGroups = organizeOptimizedTransferGroups(validatedTransfers);

    return {
        transferGroups,
        metadata: {  // Fixed property name (was metaData)
            teamMap,
            sourceTeamMap,
            destinationTeamMap,
            totalTransfers: validatedTransfers.length,
        }
    };
}

function organizeOptimizedTransferGroups(transfers) {
    const groups = new Map();

    transfers.forEach(transfer => {
        const key = `${transfer.sourceTeamId}-${transfer.destinationTeamId}`;
        
        if (!groups.has(key)) {
            groups.set(key, {
                sourceTeamId: new mongoose.Types.ObjectId(transfer.sourceTeamId),
                destinationTeamId: new mongoose.Types.ObjectId(transfer.destinationTeamId),
                employeeIds: []
            });
        }
        
        groups.get(key).employeeIds.push(new mongoose.Types.ObjectId(transfer.employeeId));
    });

    // Sort groups by team IDs to prevent deadlocks (consistent ordering)
    return Array.from(groups.values()).sort((a, b) => {
        const aKey = `${a.sourceTeamId}-${a.destinationTeamId}`;
        const bKey = `${b.sourceTeamId}-${b.destinationTeamId}`;
        return aKey.localeCompare(bKey);
    });
}

async function executeOptimizedTransferWithRetry(transferGroups, adminId, batchId, metadata) {
    let lastError;
    
    for (let attempt = 1; attempt <= MAX_RETRY_ATTEMPTS; attempt++) {
        try {
            return await executeOptimizedAtomicTransfer(transferGroups, adminId, batchId, metadata);
        } catch (error) {
            lastError = error;
            
            if (error instanceof ApiError || !isTransientError(error)) {
                throw error;
            }
            
            if (attempt < MAX_RETRY_ATTEMPTS) {
                await new Promise(resolve => setTimeout(resolve, Math.pow(2, attempt) * 1000));
            }
        }
    }
    
    throw new ApiError(500, `Transfer failed after ${MAX_RETRY_ATTEMPTS} attempts: ${lastError.message}`);
}

async function executeOptimizedAtomicTransfer(transferGroups, adminId, batchId, metadata) {
    const session = await mongoose.startSession();
    session.startTransaction();

    try {
        const timeout = setTimeout(() => {
            session.abortTransaction();
            throw new ApiError(408, "Transfer operation timed out");
        }, TRANSACTION_TIMEOUT);

       
        const preTransferState = await captureTeamStatesOptimized(transferGroups, session);

    
        const transferResults = await executeBulkTransfers(transferGroups, session, metadata);

        
        await verifyTransferConsistencyOptimized(transferGroups, session);

       
        await createOptimizedAuditTrail(batchId, adminId, transferGroups, preTransferState, session);

        clearTimeout(timeout);
        await session.commitTransaction();

        const totalTransfers = transferGroups.reduce((sum, group) => sum + group.employeeIds.length, 0);
        const affectedTeams = new Set(transferGroups.flatMap(g => [g.sourceTeamId.toString(), g.destinationTeamId.toString()]));
        
        return {
            batchId,
            totalTransfers,
            transferGroups: transferResults,
            affectedTeamsCount: affectedTeams.size,
            completedAt: new Date().toISOString(),
            performanceMetrics: {
                transferGroupsProcessed: transferGroups.length,
                bulkOperationsExecuted: transferGroups.length * 2 
            }
        };

    } catch (error) {
        await session.abortTransaction();
        throw error;
    } finally {
        await session.endSession();
    }
}

async function executeBulkTransfers(transferGroups, session, metadata) {
    const bulkRemoveOps = [];
    const bulkAddOps = [];
    const transferResults = [];

  
    transferGroups.forEach(group => {
        const { sourceTeamId, destinationTeamId, employeeIds } = group;
        const sourceTeam = metadata.teamMap.get(sourceTeamId.toString());
        const destinationTeam = metadata.teamMap.get(destinationTeamId.toString());

      
        bulkRemoveOps.push({
            updateOne: {
                filter: { 
                    _id: sourceTeamId,
                    employeeIds: { $in: employeeIds }
                },
                update: { 
                    $pull: { employeeIds: { $in: employeeIds } },
                    $set: { updatedAt: new Date() }
                }
            }
        });

       
        bulkAddOps.push({
            updateOne: {
                filter: { _id: destinationTeamId },
                update: { 
                    $addToSet: { employeeIds: { $each: employeeIds } },
                    $set: { updatedAt: new Date() }
                }
            }
        });

        transferResults.push({
            sourceTeam: { id: sourceTeamId, name: sourceTeam.teamName },
            destinationTeam: { id: destinationTeamId, name: destinationTeam.teamName },
            employeesTransferred: employeeIds.length,
            employeeIds
        });
    });

   
    const [removeResults, addResults] = await Promise.all([
        Team.bulkWrite(bulkRemoveOps, { session, ordered: false }),
        Team.bulkWrite(bulkAddOps, { session, ordered: false })
    ]);

  
    if (removeResults.modifiedCount !== transferGroups.length) {
        throw new ApiError(500, `Bulk remove operation failed. Expected: ${transferGroups.length}, Modified: ${removeResults.modifiedCount}`);
    }

    if (addResults.modifiedCount !== transferGroups.length) {
        throw new ApiError(500, `Bulk add operation failed. Expected: ${transferGroups.length}, Modified: ${addResults.modifiedCount}`);
    }

    return transferResults;
}

async function captureTeamStatesOptimized(transferGroups, session) {
    const teamIds = [...new Set(transferGroups.flatMap(g => [g.sourceTeamId, g.destinationTeamId]))];
    
    const [stateData] = await Team.aggregate([
        {
            $match: { _id: { $in: teamIds } }
        },
        {
            $project: {
                _id: 1,
                teamName: 1,
                employeeIds: 1,
                employeeCount: { $size: "$employeeIds" }
            }
        },
        {
            $group: {
                _id: null,
                teams: {
                    $push: {
                        k: { $toString: "$_id" },
                        v: {
                            teamName: "$teamName",
                            employeeCount: "$employeeCount",
                            employeeIds: {
                                $map: {
                                    input: "$employeeIds",
                                    as: "id",
                                    in: { $toString: "$$id" }
                                }
                            }
                        }
                    }
                }
            }
        },
        {
            $project: {
                _id: 0,
                teamStates: { $arrayToObject: "$teams" }
            }
        }
    ], { session });

    return stateData?.teamStates || {};
}

async function verifyTransferConsistencyOptimized(transferGroups, session) {
    const teamIds = [...new Set(transferGroups.flatMap(g => [g.sourceTeamId, g.destinationTeamId]))];
    const [consistencyCheck] = await Team.aggregate([
        {
            $match: { _id: { $in: teamIds } }
        },
        {
            $unwind: "$employeeIds"
        },
        {
            $group: {
                _id: "$employeeIds",
                teamCount: { $sum: 1 },
                teams: { $push: "$_id" }
            }
        },
        {
            $match: {
                teamCount: { $gt: 1 }
            }
        },
        {
            $project: {
                employeeId: "$_id",
                duplicateTeams: "$teams",
                _id: 0
            }
        }
    ], { session });

    if (consistencyCheck && consistencyCheck.length > 0) {
        throw new ApiError(500, `Data consistency error: Employee ${consistencyCheck[0].employeeId} found in multiple teams`);
    }

    // Verify specific transfers completed
    const verificationPipeline = await Promise.all(
        transferGroups.map(async group => {
            const [sourceCheck, destCheck] = await Promise.all([
                Team.findOne(
                    { _id: group.sourceTeamId, employeeIds: { $in: group.employeeIds } },
                    { _id: 1 }
                ).session(session).lean(),
                Team.findOne(
                    { _id: group.destinationTeamId, employeeIds: { $all: group.employeeIds } },
                    { _id: 1 }
                ).session(session).lean()
            ]);

            if (sourceCheck) {
                throw new ApiError(500, `Transfer verification failed: Some employees still in source team ${group.sourceTeamId}`);
            }
            if (!destCheck) {
                throw new ApiError(500, `Transfer verification failed: Some employees not found in destination team ${group.destinationTeamId}`);
            }
        })
    );
}

async function createOptimizedAuditTrail(batchId, adminId, transferGroups, preTransferState, session) {
    const auditRecords = transferGroups.map(group => ({
        batchId,
        adminId,
        operationType: 'BATCH_EMPLOYEE_TRANSFER',
        sourceTeamId: group.sourceTeamId,
        destinationTeamId: group.destinationTeamId,
        employeeIds: group.employeeIds,
        employeeCount: group.employeeIds.length,
        reason: 'Employee transfer by administrator',
        preTransferState: {
            sourceTeam: preTransferState[group.sourceTeamId.toString()],
            destinationTeam: preTransferState[group.destinationTeamId.toString()]
        },
        executedAt: new Date(),
        createdAt: new Date(),
        updatedAt: new Date()
    }));
    console.log('Optimized Transfer Audit Trail:', {
        batchId,
        totalRecords: auditRecords.length,
        summary: auditRecords.map(r => ({
            sourceTeam: r.sourceTeamId,
            destinationTeam: r.destinationTeamId,
            employeeCount: r.employeeCount
        }))
    });
}

function isTransientError(error) {
    const transientErrorCodes = [
        'ECONNRESET', 'ETIMEDOUT', 'ECONNREFUSED',
        11600, 11602, 13436, 13435, 189, 91, 7, 6, 89
    ];
    
    return transientErrorCodes.includes(error.code) || 
           error.name === 'MongoTimeoutError' ||
           error.name === 'MongoNetworkError' ||
           error.name === 'MongoServerError' ||
           (error.message && (
               error.message.includes('transaction') ||
               error.message.includes('timeout') ||
               error.message.includes('connection')
           ));
}

const replaceTeamManager = asyncHandler(async (req, res) => {
    const { teamId } = req.params;
    const { newManagerId } = req.body;
    const authorizedUser = req.user;


    if (!mongoose.Types.ObjectId.isValid(teamId)) {
        throw new ApiError(400, "Invalid team ID format");
    }
    if (!mongoose.Types.ObjectId.isValid(newManagerId)) {
        throw new ApiError(400, "Invalid new manager ID format");
    }
    if (authorizedUser.role !== "admin") {
        throw new ApiError(403, "Only administrators can replace team managers");
    }


    const session = await mongoose.startSession();
    session.startTransaction();

    try {

        const [team, newManager] = await Promise.all([
            Team.findOne({ _id: teamId, isActive: true }).session(session),
            User.findOne({
                _id: newManagerId,
                isActive: true,
                role: "manager"
            }).session(session)
        ]);


        if (!team) throw new ApiError(404, "Team not found or inactive");
        if (!newManager) throw new ApiError(404, "New manager not found, inactive, or not a manager");
        if (team.managerId.equals(newManagerId)) {
            throw new ApiError(400, "New manager is already the current manager");
        }
        const newManagerObjectId = new mongoose.Types.ObjectId(newManagerId);
        const updatedTeam = await Team.findByIdAndUpdate(
            teamId,
            { $set: { managerId: newManagerId } },
            { new: true, runValidators: true, session }
        );

        if (!updatedTeam) {
            throw new ApiError(500, "Failed to update team manager");
        }
        const previousManager = await User.findById(team.managerId)
            .select("name email userProfile")
            .session(session);


        await session.commitTransaction();
        const response = {
            team: {
                id: updatedTeam._id,
                name: updatedTeam.teamName,
                previousManager: {
                    id: team.managerId,
                    name: previousManager?.name,
                    email: previousManager?.email,
                    profile: previousManager?.userProfile
                },
                newManager: {
                    id: newManager._id,
                    name: newManager.name,
                    email: newManager.email,
                    profile: newManager.userProfile
                },
                updatedAt: updatedTeam.updatedAt
            }
        };

        return res.status(200).json(
            new ApiResponse(200, response, "Team manager successfully replaced")
        );
    } catch (error) {
        await session.abortTransaction();
        throw error;
    } finally {
        session.endSession();
    }
});

const getEmployeeTeam = asyncHandler(async (req, res) => {

    const { employeeId } = req.params;
    const authorizedUser = req.user;

    if (!employeeId || !mongoose.Types.ObjectId.isValid(employeeId)) {
        throw new ApiError(402, "Inavlid employee id format");
    }
    if (!["manager", "admin"].includes(authorizedUser.role)) {
        throw new ApiError(402, "Only manager / admin can access the team details through the employee");
    }
    const employee = await User.findOne({
        _id: employeeId,
        isActive: true,
        role: "employee"
    }).select("_id name email");

    if (!employee) {
        throw new ApiError(404, "Active employee not found or invalid role");
    }
    const result = await Team.aggregate([
        {
            $match: {
                employeeIds: new mongoose.Types.ObjectId(employeeId),
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
                            name: 1,
                            isActive: 1,
                            // role : 1,
                            userProfile: 1,
                            email: 1,
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
                        $match: { isActive: true }
                    },
                    {
                        $project: {
                            name: 1,
                            email: 1,
                            role: 1,
                            userProfile: 1
                        }
                    }
                ]
            }
        },
        {
            $unwind: {
                path: "$managerDetails",
                preserveNullAndEmptyArrays: true
            }
        },
        {
            $project: {
                teamName: 1,
                isActive: 1,
                manager: "$managerDetails",
                employees: {
                    $filter: {
                        input: "$employeesDetails",
                        as: "employee",
                        cond: { $ne: ["$$employee._id", employeeId] }
                    }
                },
                currentEmployee: {
                    $arrayElemAt: [
                        {
                            $filter: {
                                input: "$employeesDetails",
                                as: "emp",
                                cond: { $eq: ["$$emp._id", employeeId] }
                            }
                        },
                        0
                    ]
                }
            }
        },
        {
            $addFields: {
                teamName: "$teamName",
                employeeCount: { $size: "$employees" }
            }
        }
    ])

    if (!result || result.length === 0) {
        throw new ApiError(404, "Failed to fetch the team details through employee");
    }

    const responseData = result.map(team => ({
        teamName: team.teamName,
        isActive: team.isActive,
        manager: team.manager,
        currentEmployee: team.currentEmployee,
        teamMembers: team.employees,
        totalMembers: team.employeeCount + 1
    }))

    res.status(200).json(new ApiResponse(200, responseData[0], "successfully fetched the team detail by employee"));
})

const getAvailableEmployees = asyncHandler(async (req, res) => {
})
export { createTeam, addTeamEmployees, removeEmployeeFromTeam, getMyTeams, getTeamDetailsById, updateTeamDetails, softDeleteTeam, makeIsActiveForTeam, getTeamMembers, transferEmployee, replaceTeamManager, getEmployeeTeam, getAvailableEmployees };