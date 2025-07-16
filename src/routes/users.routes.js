import {Router} from "express";
import { registerUser, loginUser , logoutUser , refreshAccessToken} from "../controllers/user.controllers.js";
import {upload} from "../middlewares/multer.middleware.js";
import { verifyJwt } from "../middlewares/auth.middleware.js";

const router = Router();


router.route("/register").post( upload.single("profile") , registerUser);

router.route("/login").post(loginUser);

router.route("/logout").post(verifyJwt , logoutUser);

router.route("/refreshTokens").post(verifyJwt , refreshAccessToken);

export {router};