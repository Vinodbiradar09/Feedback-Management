import { ApiError } from "../utils/ApiError.js";
import { asyncHandler } from "../utils/asyncHandler.js";
import { User } from "../models/users.model.js";
import jwt from "jsonwebtoken";
import dotenv from "dotenv";
dotenv.config();

const verifyJwt = asyncHandler(async (req, res, next) => {
    try {
        const token = req.cookies?.accessToken || req.header("Authorization")?.replace("Bearer ", "");

        if (!token) {
            throw new ApiError(401, "Unauthorized User's request");
        }
        const decoded = jwt.verify(token, process.env.ACCESS_TOKEN_SECRET);
        if (!decoded) {
            throw new ApiError(404, "Failed to decode the tokens");
        }
        const user = await User.findById(decoded._id).select("-password -refreshTokens");
        if (!user) {
            throw new ApiError(403, "no user found");
        }
        req.user = user;
        next();
    } catch (error) {
        throw new ApiError(401, error.message || "Invalid Access Token")
    }
})

export {verifyJwt};