import { ApiError } from "../utils/ApiError.js";
import { ApiResponse } from "../utils/ApiResponse.js";
import { asyncHandler } from "../utils/asyncHandler.js";
import { User } from "../models/users.model.js";
import { uploadOnCloudinary } from "../utils/cloudinary.js";
import dayjs from "dayjs";
import { validateEmail, validatePassword } from "../utils/validators.js";



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

const loginUser = asyncHandler(async(req , res)=>{
    
})

export { registerUser };