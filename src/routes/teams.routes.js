import {Router} from "express";
import { verifyJwt } from "../middlewares/auth.middleware.js";
import {createTeam , addTeamEmployees , removeEmployeeFromTeam  , getMyTeams}  from "../controllers/teams.controllers.js";

const teamrouter = Router();

teamrouter.route("/createTeam").post(verifyJwt , createTeam);

teamrouter.route("/addEmployee/:teamId").patch(verifyJwt , addTeamEmployees);

teamrouter.route("/removeEmplyee/:teamId").patch(verifyJwt , removeEmployeeFromTeam);

teamrouter.route("/getMyTeams").get(verifyJwt , getMyTeams );
export {teamrouter};