import {Router} from "express";
import { registerUser } from "../controllers/user.controllers.js";
import {upload} from "../middlewares/multer.middleware.js";

const router = Router();


router.route("/register").post( upload.single("profile") , registerUser);

export {router};