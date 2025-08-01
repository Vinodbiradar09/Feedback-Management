import {Router} from "express";
import { registerUser, loginUser , logoutUser , refreshAccessToken , getProfile , forgotPassword , resetPassword , updateUserDetails , updateUsersProfile , changePassword , softdeactivateAccount , getUserById , updateUserRole , searchUsers , getAllUsersWhoseRoleIsEmployee , getAllUsersWhoseRoleIsManagerAndEmployee , getUserEmployeeDetails , getUserManagerDetails} from "../controllers/user.controllers.js";
import {upload} from "../middlewares/multer.middleware.js";
import { verifyJwt } from "../middlewares/auth.middleware.js";

const router = Router();


router.route("/register").post( upload.single("profile") , registerUser);

router.route("/login").post(loginUser);

router.route("/logout").post(verifyJwt , logoutUser);

router.route("/refreshTokens").post(verifyJwt , refreshAccessToken);

router.route("/getProfile").get(verifyJwt , getProfile);

router.route("/forgot-password").post(forgotPassword);

router.route("/reset-password").post(verifyJwt , resetPassword);

router.route("/details").patch(verifyJwt , updateUserDetails);

router.route("/updateProfile").patch( upload.single("profile") ,verifyJwt , updateUsersProfile);

router.route("/changePassword").patch(verifyJwt , changePassword);

router.route("/softdelete").patch(verifyJwt , softdeactivateAccount);

router.route("/getUser/:targetUserId").get(verifyJwt , getUserById);

router.route("/updateRole/:targetedUserId").patch(verifyJwt , updateUserRole);

router.route("/getAllUserEmployee").get(verifyJwt , getAllUsersWhoseRoleIsEmployee);

router.route("/getAllUsers").get(verifyJwt , getAllUsersWhoseRoleIsManagerAndEmployee);

router.route("/getEmployeeDetails/:employeeId").get(verifyJwt , getUserEmployeeDetails);

router.route("/getManagerDetails/:managerId").get(verifyJwt , getUserManagerDetails);


export {router}; 