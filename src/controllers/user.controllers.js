import { ApiError } from "../utils/ApiError.js";
import { ApiResponse } from "../utils/ApiResponse.js";
import { asyncHandler } from "../utils/asyncHandler.js";
import { User } from "../models/users.model.js";
import { deleteOnCloudinary, uploadOnCloudinary } from "../utils/cloudinary.js";
import dayjs from "dayjs";
import { validateEmail, validatePassword, commonPasswords } from "../utils/validators.js";
import { options } from "../utils/cookies.js";
import jwt from "jsonwebtoken";
import { sendEmail } from "../utils/sendEmail.js";
import mongoose from "mongoose";
import { application } from "express";
import { Team } from "../models/teams.model.js";

const generateAccessAndRefreshTokens = async (userId) => {
    try {
        if (!userId) {
            throw new ApiError(402, "Empty user id");
        }
        const user = await User.findById(userId);
        if (!user) {
            throw new ApiError(500, "No user found");
        }

        const accessToken = await user.generateAccessToken();
        const refreshToken = await user.generateRefreshToken();

        if (!accessToken && !refreshToken) {
            throw new ApiError(409, "failed to generate the tokens");
        }
        user.refreshTokens = refreshToken;
        await user.save({ validateBeforeSave: false });

        return { accessToken, refreshToken };

    } catch (error) {
        throw new ApiError(500, "Something went wrong while generating the access token and refresh tokens ")
    }
}

const registerUser = asyncHandler(async (req, res) => {
    const { email, password, name, role } = req.body;

    if ([email, password, name, role].some((field) => field.trim() === "")) {
        throw new ApiError(401, "All the fields are required please fill it");
    }
    if (!validateEmail(email)) {
        throw new ApiError(400, "Invalid email format.");
    }
    if (!validatePassword(password)) {
        throw new ApiError(400, "Password must be at least 6 characters.");
    }

    const existedUser = await User.findOne({ email });

    if (existedUser) {
        throw new ApiError(409, "Email already registered");
    }
    const profile = req.file?.path;
    if (!profile) {
        throw new ApiError(403, "Empty profile path");
    }

    const userProfile = await uploadOnCloudinary(profile);
    if (!userProfile.secure_url) {
        throw new ApiError(403, "failed to upload profile image on the cloudinary");
    }

    const lastLogin = new Date();

    const user = await User.create({
        email,
        name,
        password,
        userProfile: userProfile.secure_url,
        role,
        isActive: true,
        lastLogin,

    })

    if (!user) {
        throw new ApiError(500, "failed to create user ");
    }

    const sanitizedUser = await User.findById(user._id).select("-password -refreshTokens");
    if (!sanitizedUser) {
        throw new ApiError(500, "failed to get the created user");
    }

    res.status(200).json(new ApiResponse(200, sanitizedUser, "User created successfully"));
})

const loginUser = asyncHandler(async (req, res) => {
    const { email, password } = req.body;
    if (!email && !password) {
        throw new ApiError(400, "Email and password are required.");
    }
    if (!validateEmail(email)) {
        throw new ApiError(400, "Invalid email format");
    }
    const user = await User.findOne({ email });
    if (!user) {
        throw new ApiError(404, "No user found with this email.");
    }

    const isPasswordValid = await user.isPasswordCorrect(password);
    if (!isPasswordValid) {
        throw new ApiError(401, "Invalid password or email please check creds");
    }

    const { accessToken, refreshToken } = await generateAccessAndRefreshTokens(user._id);

    if (!accessToken && !refreshToken) {
        throw new ApiError(500, "Failed to generate authentication tokens.");
    }

    user.lastLogin = new Date();
    user.isActive = true;
    await user.save();

    const loggedInUser = await User.findById(user._id).select("-password -refreshTokens");
    if (!loggedInUser) {
        throw new ApiError(404, "User not found after login.");
    }

    res.status(200)
        .cookie("accessToken", accessToken, options)
        .cookie("refreshToken", refreshToken, options)
        .json(new ApiResponse(201, { user: loggedInUser, accessToken, refreshToken }, "Successfully user logged In"));


})

const logoutUser = asyncHandler(async (req, res) => {
    const userId = req.user?._id;
    if (!userId) {
        throw new ApiError(404, "Invalid access , please login");
    }

    const user = await User.findByIdAndUpdate(userId,
        {
            $unset: {
                refreshTokens: 1,
            }
        },
        {
            new: true,
        }
    )

    if (!user) {
        throw new ApiError(404, "failed to clear the refreshTokens");
    }

    res.status(201)
        .clearCookie("accessToken", options)
        .clearCookie("refreshToken", options)
        .json(new ApiResponse(200, {}, "user logged out successfully"));
})

const refreshAccessToken = asyncHandler(async (req, res) => {
    try {
        const incomingRefreshToken = req.cookies.refreshToken || req.body.refreshToken;
        if (!incomingRefreshToken) {
            throw new ApiError(403, "No tokens are available");
        }
        const decoded = jwt.verify(incomingRefreshToken, process.env.REFRESH_TOKEN_SECRET)
        if (!decoded) {
            throw new ApiError(401, "failed to decode the refresh tokens");
        }

        const user = await User.findById(decoded._id);
        if (!user) {
            throw new ApiError(404, "No user found");
        }

        if (incomingRefreshToken !== user.refreshTokens) {
            throw new ApiError(500, "No tokens matches btw incoming and db tokens");
        }

        const { accessToken, refreshToken } = await generateAccessAndRefreshTokens(user._id)

        if (!accessToken && !refreshToken) {
            throw new ApiError(403, "failed to generate the tokens");
        }

        res.status(200).cookie("accessToken", accessToken, options).cookie("refreshToken", refreshToken, options).json(new ApiResponse(200, { accessToken, refreshToken }, "successfully generated tokens"))


    } catch (error) {
        throw new ApiError(401, error?.message || "Invalid refresh token")
    }
})

const forgotPassword = asyncHandler(async (req, res) => {
    const { email } = req.body;
    if (!email) {
        throw new ApiError(403, "Email is required to reset password");
    }

    const user = await User.findOne({ email });
    if (!user) {
        throw new ApiError(405, "Invalid email , If the email exists, a reset link will be sent");
    }

    const { accessToken, refreshToken } = await generateAccessAndRefreshTokens(user._id);
    if (!accessToken && !refreshToken) {
        throw new ApiError(402, "failed to generate the tokens");
    }

    const resetLink = `${process.env.BASE_URL}/reset-password?token=${accessToken}`;
    const htmlContent =
        `
    <p>Hello ${user.name}, </p>
    <p>You requested a password reset </p>
    <p>Click the link below to reset your password:</p>
    <a href="${resetLink}">${resetLink}</a>
    <p>This link will expire in 15 minutes.</p>
    `;

    await sendEmail({
        to: user.email,
        subject: "reset your password",
        html: htmlContent,
    })

    res.status(200).json(new ApiResponse(200, "If the email exists, a reset link will be sent."));
})

const resetPassword = asyncHandler(async (req, res) => {
    const { token, newPassword } = req.body;
    if (!token || !newPassword) {
        throw new ApiError(406, "Token and new password are required.")
    }

    const decode = jwt.verify(token, process.env.ACCESS_TOKEN_SECRET);
    if (!decode) {
        throw new ApiError(403, "failed to decode the tokens");
    }

    const userId = decode._id;
    if (!userId) {
        throw new ApiError(402, "failed to get the userID");
    }
    const user = await User.findById(userId).select("-password -refreshTokens");
    if (!user) {
        throw new ApiError(404, "failed to get the user");
    }

    user.password = newPassword;
    await user.save();


    res.status(200).json(new ApiResponse(200, user, "Password reset successful."));
})

const getProfile = asyncHandler(async (req, res) => {
    const user = req.user;
    if (!user) {
        throw new ApiError(403, "failed to get the user");
    }
    res.status(200).json(new ApiResponse(200, user, "fetched the user profile"));
})

const updateUserDetails = asyncHandler(async (req, res) => {
    const user = req.user;
    if (!user) {
        throw new ApiError(403, "Unauthorized access - please login");
    }
    const fields = ["name", "email"];
    const updateData = {};

    let hasValidFields = false;

    fields.forEach(field => {
        if (req.body[field] !== undefined && req.body[field] !== null && req.body[field] !== "") {
            updateData[field] = req.body[field];
            hasValidFields = true;
        }
    })

    if (!hasValidFields) {
        return res.status(200).json(
            new ApiResponse(200, user, "No valid fields provided to update")
        );
    }

    const session = await mongoose.startSession();

    try {
        session.startTransaction();

        const updatedUser = await User.findByIdAndUpdate(user._id, {
            $set: updateData,

        }, {
            new: true,
            runValidators: true,
            select: "-password -refreshTokens",
            session
        });

        if (!updatedUser) {
            throw new ApiError(404, "User not found");
        }

        await session.commitTransaction();

        return res.status(200).json(new ApiResponse(200, updatedUser, `successfully updated: ${Object.keys(updateData).join(' ,')}`));
    } catch (error) {
        await session.abortTransaction();
        throw error;
    } finally {
        session.endSession();
    }
});

const updateUsersProfile = asyncHandler(async (req, res) => {
    const user = req.user;
    if (!user) {
        throw new ApiError(401, "Unauthorized access. Please login");
    }
    const profile = req.file?.path;
    if (!profile) {
        throw new ApiError(400, "Profile image file is required");
    }

    const userProfile = await uploadOnCloudinary(profile);
    if (!userProfile?.secure_url) {
        throw new ApiError(500, "Failed to upload image to Cloudinary");
    }
    const oldUrl = user.userProfile;
    if (!oldUrl) {
        throw new ApiError(403, "Old secure url is missing to delete on cloudinary");
    }
    const updatedProfile = await User.findByIdAndUpdate(user._id, {
        $set: {
            userProfile: userProfile.secure_url,
        }
    },
        {
            new: true,
            runValidators: true,
            select: "-password -refreshTokens"
        })

    if (!updatedProfile) {
        throw new ApiError(404, "failed to update the user's profile");
    }

    const oldProfileDeletion = await deleteOnCloudinary(oldUrl);
    if (!oldProfileDeletion) {
        throw new ApiError(500, "failed to delete old user's profile on cloudinary");
    }

    res.status(200).json(new ApiResponse(200, updatedProfile, "successfully updated user's profile"));
})

const changePassword = asyncHandler(async (req, res) => {

    const userId = req.user;
    if (!userId) {
        throw new ApiError(404, "unauthorized access please login");
    }

    const fields = ["oldPassword", "newPassword", "retryNewPassword"];
    const data = {};
    let hasValidFields = false;
    fields.forEach((field) => {
        if (req.body[field] !== undefined && req.body[field] !== null && req.body[field] !== "") {
            data[field] = req.body[field];
            hasValidFields = true;
        }
    })

    if (!hasValidFields) {
        throw new ApiError(404, "All the fields are required to change the password");
    }

    if (!validatePassword(data.newPassword)) {
        throw new ApiError(402, "password must be atleast six chars");
    }
    const user = await User.findById(userId);
    if (!user) {
        throw new ApiError(404, "no users found");
    }

    console.log("pps", data.oldPassword);
    const isPasswordValid = await user.isPasswordCorrect(data.oldPassword);
    if (!isPasswordValid) {
        throw new ApiError(400, "Current password is incorrect");
    }

    if (data.newPassword !== data.retryNewPassword) {
        throw new ApiError(403, "There is no match between newPassword and retryNewPassword");
    }

    if (data.oldPassword === data.newPassword) {
        throw new ApiError(402, "the new password must be different from old password");
    }
    // if(commonPasswords(data.newPassword)){
    //     throw new ApiError(401 , "password is too easy to guess");
    // }
    const updatedUserPassword = user.password = data.newPassword;
    await user.save();

    if (!updatedUserPassword) {
        throw new ApiError(500, "failed to update the user's new password");
    }

    res.status(200).json(new ApiResponse(200, {}, "user password updated successfully"));

})

const softdeactivateAccount = asyncHandler(async (req, res) => {
    const user = req.user;
    if (!user) {
        throw new ApiError(404, "unauthorized access please login");
    }

    const userActivateFalse = await User.findByIdAndUpdate(user._id, {
        $set: {
            isActive: false,
        }
    },
        {
            new: true,
            runValidators: true,
        }).select("-password -refreshTokens");

    if (!userActivateFalse) {
        throw new ApiError(404, "failed to soft delete the user's account");
    }

    res.status(200).json(new ApiResponse(200, userActivateFalse, "successfully soft deleted the user account"))
})

const getUserById = asyncHandler(async (req, res) => {
    const requesterUser = req.user;
    const { targetUserId } = req.params;

    if (!requesterUser) {
        throw new ApiError(404, "user not found , unauthorized access");
    }
    if (!targetUserId || !mongoose.Types.ObjectId.isValid(targetUserId)) {
        throw new ApiError(400, "Invalid user ID format");
    }

    const isAuthorized = requesterUser.role === "manager" || requesterUser._id.toString() === targetUserId.toString() || requesterUser.role === "admin";

    if (!isAuthorized) {
        throw new ApiError(403, "Forbidden: Insufficient permissions");
    }

    const targetedUser = await User.findById(targetUserId).select("-password -refreshTokens");

    if (!targetedUser) {
        throw new ApiError(404, "User not found");
    }
    res.status(200).json(new ApiResponse(200, targetedUser, "user successfully fetched by Id"));
})

const updateUserRole = asyncHandler(async (req, res) => {

    const adminUser = req.user;
    const { targetedUserId } = req.params;
    const { role } = req.body;

    if (!adminUser) {
        throw new ApiError(404, "Admin not found or unauthorized access");
    }
    if (!targetedUserId || !mongoose.Types.ObjectId.isValid(targetedUserId)) {
        throw new ApiError(400, "Invalid user ID format");
    }
    if (!role) {
        throw new ApiError(402, "role must be required");
    }
    const validRoles = ["manager", "employee"];
    if (!validRoles.includes(role)) {
        throw new ApiError(400, "Invalid role provided");
    }
    const targetUser = await User.findById(targetedUserId).select("-password -refreshTokens");
    let updatedRole;

    if (targetUser.role === role) {
        throw new ApiError(401, "can't change the same role twice");
    }

    if (targetUser.role === "admin") {
        throw new ApiError(408, "you can't promote the user to admin , invalid access and unauthorized activity");
    }

    if (adminUser.role === "admin" && targetUser.isActive === true && targetUser.role !== role && targetUser.role !== "admin") {
        updatedRole = await User.findByIdAndUpdate(targetedUserId, {
            $set: {
                role,
            }
        },
            {
                new: true,
                runValidators: true,
            })
    }

    if (!updatedRole) {
        throw new ApiError(500, "failed to update the users role");
    }
    res.status(200).json(new ApiResponse(200, updatedRole, "successfully updated the users role"));
})

const searchUsers = asyncHandler(async (req, res) => {
    const startTime = Date.now();

    if (!["manager", "admin"].includes(req.user.role)) {
        throw new ApiError(403, "Only admin and managers can search users");
    }
    const {
        query = "",
        page = 1,
        limit = 10,
        sortBy = "name",
        sortOrder = "asc"
    } = req.query;
    if (!query || !query.trim().length < 2) {
        throw new ApiError(400, "Search query must be at least 2 characters long");
    }

    const sanitizedQuery = query.trim().replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const searchRegex = new RegExp(sanitizedQuery, 'i');

    const pageNum = Math.max(1, parseInt(page));
    const pageSize = Math.min(50, Math.max(1, parseInt(limit)));
    const skip = (pageNum - 1) * pageSize;

    const [result] = await User.aggregate([
        {
            $match: {
                isActive: true,
                $or: [
                    { email: searchRegex },
                    { name: searchRegex },
                ]
            }
        },
        {
            $addFields: {
                relevanceScore: {
                    $sum: [
                        { $cond: [{ $eq: ["$email", query.toLowerCase().trim()] }, 100, 0] },
                        { $cond: [{ $eq: [{ $toLower: "$name" }, query.toLowerCase().trim()] }, 95, 0] },
                        { $cond: [{ $regexMatch: { input: "$email", regex: new RegExp(`^${sanitizedQuery}`, 'i') } }, 50, 0] },
                        { $cond: [{ $regexMatch: { input: "$name", regex: new RegExp(`^${sanitizedQuery}`, 'i') } }, 45, 0] },
                        { $cond: [{ $regexMatch: { input: "$email", regex: searchRegex } }, 25, 0] },
                        { $cond: [{ $regexMatch: { input: "$name", regex: searchRegex } }, 20, 0] }
                    ]
                }
            }
        },
        {
            $lookup: {
                from: "teams",
                let: { userId: "$_id" },
                pipeline: [
                    {
                        $match: {
                            $expr: {
                                $and: [
                                    { $in: ["$$userId", "$employeeIds"] },
                                    { $eq: ["$isActive", true] },
                                ]
                            }
                        }
                    },
                    {
                        $lookup: {
                            from: "users",
                            localField: "managerId",
                            foreignField: "_id",
                            as: "manager",
                        }
                    },
                    {
                        $project: {
                            _id: 1,
                            teamName: 1,
                            managerId: 1,
                            manager: {
                                $arrayElemAt: [
                                    {
                                        $map: {
                                            input: "$manager",
                                            as: "mgr",
                                            in: {
                                                _id: "$$mgr._id",
                                                name: "$$mgr.name",
                                                email: "$$mgr.email",
                                            }
                                        }
                                    }, 0
                                ]
                            },
                            createdAt: 1

                        }
                    }
                ],
                as: "teamAssignments",
            }
        },

        {
            $lookup: {
                from: "feedbacks",
                let: { userId: "$_id" },
                pipeline: [
                    {
                        $match: {
                            $expr: {
                                $and: [
                                    { $eq: ["$toEmployeeId", "$userId"] },
                                    { $eq: ["$isDeleted", false] },
                                ]
                            }
                        }
                    },
                    {
                        $sort: { createdAt: -1 },
                    },
                    {
                        $limit: 1
                    },
                    {
                        $project: {
                            _id: 1,
                            sentiment: 1,
                            isAcknowledged: 1,
                            createdAt: 1
                        }
                    }
                ],
                as: "latestFeedback"
            }
        },
        {
            $lookup: {
                from: "feedbacks",
                let: { userId: "$_id" },
                pipeline: [
                    {
                        $match: {
                            $expr: {
                                $and: [
                                    { $eq: ["$toEmployeeId", "$userId"] },
                                    { $eq: ["$isDeleted", false] },
                                ]
                            }
                        }
                    },
                    {
                        $count: "total",
                    }
                ],
                as: "feedbackCount"
            }
        },
        {
            $project: {
                _id: 1,
                email: 1,
                name: 1,
                role: 1,
                userProfile: 1,
                isActive: 1,
                lastLogin: 1,
                createdAt: 1,
                updatedAt: 1,
                relevanceScore: 1,

                teamInfo: {
                    isAssigned: { $gt: [{ $size: "$teamAssignments" }, 0] },
                    teams: "$teamAssignments",
                    totalTeams: { $size: "$teamAssignments" }
                },
                feedbackInfo: {
                    totalFeedbacks: { $ifNull: [{ $arrayElemAt: ["$feedbackCount.total", 0] }, 0] },
                    latestFeedback: { $arrayElemAt: ["$latestFeedback", 0] }
                }
            }
        },
        {
            $sort: {
                relevanceScore: -1,
                [sortBy]: sortOrder === "desc" ? -1 : 1
            }
        },
        {
            $facet: {
                users: [
                    { $skip: skip },
                    { $limit: pageSize }
                ],
                totalCount: [
                    { $count: "count" }
                ]
            }
        }
    ])
    const users = result.users || [];
    const totalCount = result.totalCount[0]?.count || 0;
    const totalPages = Math.ceil(totalCount / pageSize);
    const hasNextPage = pageNum < totalPages;
    const hasPreviousPage = pageNum > 1;
    const executionTime = Date.now() - startTime;

    const formattedUsers = users.map(user => ({
        _id: user._id,
        email: user.email,
        name: user.name,
        role: user.role,
        userProfile: user.userProfile,
        isActive: user.isActive,
        lastLogin: user.lastLogin,
        createdAt: user.createdAt,
        updatedAt: user.updatedAt,

        teamAssignments: {
            isAssigned: user.teamInfo.isAssigned,
            totalTeams: user.teamInfo.totalTeams,
            teams: user.teamInfo.teams
        },

        feedbackSummary: {
            totalReceived: user.feedbackInfo.totalFeedbacks,
            latestFeedback: user.feedbackInfo.latestFeedback
        },
        searchRelevance: user.relevanceScore
    }));

    const response = {
        users: formattedUsers,
        pagination: {
            currentPage: pageNum,
            pageSize,
            totalCount,
            totalPages,
            hasNextPage,
            hasPreviousPage
        },

        searchQuery: query,
        executionTime: `${executionTime}ms`
    };

    return res.status(200).json(
        new ApiResponse(
            200,
            response,
            `Found ${users.length} users matching "${query}" with complete details`
        )
    );

});

const getAllUsersWhoseRoleIsEmployee = asyncHandler(async (req, res) => {
    const requesterUser = req.user;

    if (!requesterUser) {
        throw new ApiError(404, "unauthorized access , please login");
    }
    if (!["manager", "admin"].includes(requesterUser.role)) {

        throw new ApiError(409, "forbidden error , you are not authorized ");
    }
    const {
        page = 1,
        limit = 10,
    } = req.query;

    const pageNum = Math.max(1, parseInt(page));
    const pageSize = Math.min(100, Math.max(1, parseInt(limit)));
    const skip = (pageNum - 1) * pageSize;

    const filter = {
        role: "employee",
        isActive: true,
    };

    const users = await User.find(filter).skip(skip).limit(pageSize).sort({ createdAt: 1 }).select("-password -refreshTokens");
    if (!users || users.length < 0) {
        throw new ApiError(404, "No employees in db");
    }

    const totalCount = await User.countDocuments(filter);
    const totalPages = Math.ceil(totalCount / pageSize);

    res.status(200).json({
        users,
        pagination: {
            currentPage: pageNum,
            pageSize,
            totalCount,
            totalPages,
            hasNextPage: pageNum < totalPages,
            hasPreviousPage: pageNum > 1
        }
    });

})

const getAllUsersWhoseRoleIsManagerAndEmployee = asyncHandler(async (req, res) => {
    const adminUser = req.user;
    if (!adminUser && adminUser.role !== "admin") {
        throw new ApiError(409, "unauthorized access and invalid user");
    }
    const {
        page = 1,
        limit = 10,
    } = req.query;

    const pageNum = Math.max(1, parseInt(page));
    const pageSize = Math.min(100, Math.max(1, parseInt(limit)));
    const skip = (pageNum - 1) * pageSize;

    const filter = {
        role: { $in: ["manager", "employee"] },
        isActive: true,
    }

    const users = await User.find(filter)
        .skip(skip)
        .limit(pageSize)
        .sort({ createdAt: 1 })
        .select("-password -refreshTokens");

    if (!users || users.length < 0) {
        throw new ApiError(408, "No employee and managers in db");
    }

    const totalCount = await User.countDocuments(filter);
    const totalPages = Math.ceil(totalCount / pageSize);

    res.status(200).json({
        users,
        pagination: {
            currentPage: pageNum,
            pageSize,
            totalCount,
            totalPages,
            hasNextPage: pageNum < totalPages,
            hasPreviousPage: pageNum > 1
        }
    });
})

const getUserEmployeeDetails = asyncHandler(async (req, res) => {
    const { employeeId } = req.params;
    const manager = req.user;

    if (!employeeId || !mongoose.isValidObjectId(employeeId)) {
        throw new ApiError(400, "Invalid format of the employeeId");
    }

    if (manager.role !== "manager") {
        throw new ApiError(403, "Only managers can access employee details");
    }

    const employeeExists = await User.findById(employeeId).select("_id isActive");
    if (!employeeExists || !employeeExists.isActive) {
        throw new ApiError(404, "Employee does not exist or is inactive");
    }

    const employeeInfo = await Team.aggregate([
        {
            $match: {
                managerId: new mongoose.Types.ObjectId(manager._id),
                employeeIds: new mongoose.Types.ObjectId(employeeId),
                isActive: true,
            }
        },
        {
            $lookup: {
                from: "users",
                let: { empIds: "$employeeIds" },
                pipeline: [
                    {
                        $match: {
                            $expr: {
                                $and: [
                                    { $in: ["$_id", "$$empIds"] },
                                    { $eq: ["$_id", new mongoose.Types.ObjectId(employeeId)] }
                                ]
                            }
                        }
                    },
                    {
                        $project: {
                            name: 1,
                            email: 1,
                            role: 1,
                            isActive: 1,
                            userProfile: 1
                        }
                    }
                ],
                as: "employeeDetails"
            }
        },
        {
            $addFields: {
                employee: { $arrayElemAt: ["$employeeDetails", 0] }
            }
        },
        {
            $project: {
                teamName: 1,
                employee: 1
            }
        }
    ]);

    if (!employeeInfo || employeeInfo.length === 0) {
        throw new ApiError(404, "Employee not found in your team or unauthorized access");
    }

    return res
        .status(200)
        .json(new ApiResponse(200, employeeInfo, "Successfully retrieved employee details"));
});

const getUserManagerDetails = asyncHandler(async (req, res) => {
    const admin = req.user;
    const { managerId } = req.params;

    if (admin.role !== "admin") {
        throw new ApiError(403, "Only admins can access manager details");
    }

    if (!managerId || !mongoose.isValidObjectId(managerId)) {
        throw new ApiError(400, "Invalid or missing managerId");
    }

    const managerInfo = await Team.aggregate([
        {
            $match: {
                managerId: new mongoose.Types.ObjectId(managerId),
                isActive: true,
            },
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
                            userProfile: 1,
                            role: 1,
                            isActive: 1,
                        },
                    },
                ],
            },
        },
        { $unwind: "$managerDetails" },
        {
            $project: {
                teamName: 1,
                manager: "$managerDetails",
            },
        },
    ]);

    if (!managerInfo || managerInfo.length === 0) {
        throw new ApiError(404, "No active team found for this manager");
    }

    res.status(200).json(
        new ApiResponse(200, managerInfo[0], "Manager details retrieved successfully")
    );
});

export { registerUser, loginUser, logoutUser, refreshAccessToken, getProfile, forgotPassword, resetPassword, updateUserDetails, updateUsersProfile, changePassword, softdeactivateAccount, getUserById, updateUserRole, searchUsers, getAllUsersWhoseRoleIsEmployee, getAllUsersWhoseRoleIsManagerAndEmployee, getUserEmployeeDetails, getUserManagerDetails };