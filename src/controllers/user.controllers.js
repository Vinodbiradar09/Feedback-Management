import { ApiError } from "../utils/ApiError.js";
import { ApiResponse } from "../utils/ApiResponse.js";
import { asyncHandler } from "../utils/asyncHandler.js";
import { User } from "../models/users.model.js";
import { uploadOnCloudinary } from "../utils/cloudinary.js";
import dayjs from "dayjs";
import { validateEmail, validatePassword } from "../utils/validators.js";
import {options} from "../utils/cookies.js";

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
    if(!validateEmail(email)){
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

    const {accessToken , refreshToken} = await generateAccessAndRefreshTokens(user._id);

    if(!accessToken && !refreshToken){
      throw new ApiError(500, "Failed to generate authentication tokens.");
    }

    user.lastLogin = new Date();
    await user.save();

    const loggedInUser = await User.findById(user._id).select("-password -refreshTokens");
    if(!loggedInUser){
       throw new ApiError(404, "User not found after login.");
    }

    res.status(200)
    .cookie("accessToken" , accessToken , options)
    .cookie("refreshToken" , refreshToken ,options)
    .json(new ApiResponse(201 , {user:loggedInUser , accessToken , refreshToken} , "Successfully user logged In"));


})

const logoutUser = asyncHandler(async(req , res)=>{
    const userId = req.user?._id;
    if(!userId){
        throw new ApiError(404 , "Invalid access , please login");
    }

    const user = await User.findByIdAndUpdate(userId , 
        {
            $unset : {
                refreshTokens : 1,
            }
        },
        {
            new : true,
        }
    )

    if(!user){
        throw new ApiError(404 , "failed to clear the refreshTokens");
    }

    res.status(201)
    .clearCookie("accessToken" , options)
    .clearCookie("refreshToken" , options)
    .json(new ApiResponse(200 , {} , "user logged out successfully"));
})
export { registerUser , loginUser , logoutUser };