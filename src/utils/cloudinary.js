import { v2 as cloudinary } from "cloudinary";
import dotenv from "dotenv";
dotenv.config();

import fs from "fs";



cloudinary.config(
    {
        cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
        api_key: process.env.CLOUDINARY_API_KEY,
        api_secret: process.env.CLOUDINARY_API_SECRET,
    }
)


const uploadOnCloudinary = async (localFilePath) => {
    try {
        if (!localFilePath) return null;
        const response = await cloudinary.uploader.upload(localFilePath, { resource_type: 'auto', });
        fs.unlinkSync(localFilePath);
        return response;
    }
    catch (error) {
        fs.unlinkSync(localFilePath);
        return null
    }
}

const deleteOnCloudinary = async (public_id) => {

    try {
        if (!public_id) return null;
        let actualPublicID = public_id;
        if (public_id.includes('cloudinary.com')) {
            // Extract public_id from URL
            actualPublicID = public_id.split('/').pop().split('.')[0];
            console.log("actual", actualPublicID)
        }
        const result = await cloudinary.uploader.destroy(actualPublicID);
        console.log("res", result);
        return result.result === "ok";
    } catch (error) {
        console.error("Cloudinary delete error:", error);
        return null
    }

}

export {uploadOnCloudinary , deleteOnCloudinary};