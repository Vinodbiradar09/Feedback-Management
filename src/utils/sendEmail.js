import nodemailer from "nodemailer";
import dotenv from "dotenv";
import { ApiError } from "./ApiError.js";
dotenv.config();

const sendEmail = async ({ to, subject, html }) => {
    try {
        const transporter = nodemailer.createTransport({
            service: 'gmail',
            auth: {
                user: process.env.SMTP_EMAIL,
                pass: process.env.SMTP_PASSWORD,
            }
        })
        const mailOptions = {
            from: `"FeedbackFlow" <${process.env.SMTP_EMAIL}>`,
            to,
            subject,
            html
        }
        const info = await transporter.sendMail(mailOptions);
        console.log("email info", info);
        if (!info) {
            throw new ApiError(404, "failed to send the email");
        }
        
    } catch (error) {
         console.error("Error sending email:", error);
         throw new ApiError( 409 ,"Email sending failed");
    }
}

export{sendEmail};
