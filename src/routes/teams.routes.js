import {Router} from "express";
import { verifyJwt } from "../middlewares/auth.middleware.js";
import {createTeam} from "../controllers/teams.controllers.js";

const teamrouter = Router();

teamrouter.route("/createTeam").post(verifyJwt , createTeam);

export {teamrouter};