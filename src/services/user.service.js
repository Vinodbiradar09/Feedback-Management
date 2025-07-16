import { User } from "../models/users.model.js";
import { ApiError } from "../utils/ApiError.js";


const findUserByEmail = async(email)=>{
    try {
        const user = await User.findOne({email});
        if(!user){
            throw new ApiError(403 , "failed to get the user by email");
        }

        return user;
    } catch (error) {
        throw new ApiError(500 , error.message , "failed to get the user by email");
    }
}

export {findUserByEmail};
