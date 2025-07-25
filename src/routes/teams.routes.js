import {Router} from "express";
import { verifyJwt } from "../middlewares/auth.middleware.js";
import {createTeam , addTeamEmployees , removeEmployeeFromTeam  , getMyTeams  , getTeamDetailsById , updateTeamDetails , softDeleteTeam , makeIsActiveForTeam , getTeamMembers , transferEmployee , replaceTeamManager , getEmployeeTeam , getAvailableEmployees}  from "../controllers/teams.controllers.js";

const teamrouter = Router();

teamrouter.route("/createTeam").post(verifyJwt , createTeam);

teamrouter.route("/addEmployee/:teamId").patch(verifyJwt , addTeamEmployees);

teamrouter.route("/removeEmplyee/:teamId").patch(verifyJwt , removeEmployeeFromTeam);

teamrouter.route("/getMyTeams").get(verifyJwt , getMyTeams );

teamrouter.route("/teamDetailsById/:teamId").get(verifyJwt , getTeamDetailsById)

teamrouter.route("/updateDetails/:teamId").patch(verifyJwt , updateTeamDetails);

teamrouter.route("/softDeleteTeam/:teamId").patch(verifyJwt , softDeleteTeam);

teamrouter.route("/activeTeam/:teamId").patch(verifyJwt , makeIsActiveForTeam );

teamrouter.route("/teamMembers/:teamId").get(verifyJwt , getTeamMembers);

teamrouter.route("/getEmployeeTeam/:employeeId").get(verifyJwt , getEmployeeTeam);

teamrouter.route("/replaceManager/:teamId").patch(verifyJwt , replaceTeamManager);

teamrouter.route("/transferEmployee").patch(verifyJwt , transferEmployee);
export {teamrouter};