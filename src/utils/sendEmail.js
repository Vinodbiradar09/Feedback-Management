import nodemailer from "nodemailer";
import dotenv from "dotenv";
import { ApiError } from "./ApiError.js";
dotenv.config();

let emailTransporter = null;

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

const getEmailTransporter = () => {
    try {
        if (!emailTransporter) {
          
            if (!process.env.SMTP_EMAIL || !process.env.SMTP_PASSWORD) {
                throw new Error("SMTP configuration not found in environment variables");
            }

            console.log('Creating email transporter...');
            
            emailTransporter = nodemailer.createTransport({
                service: 'gmail',
                auth: {
                    user: process.env.SMTP_EMAIL,
                    pass: process.env.SMTP_PASSWORD
                },
                pool: true,
                maxConnections: 5,
                maxMessages: 100,
                rateLimit: 10,
            });


            emailTransporter.verify((error, success) => {
                if (error) {
                    console.error('Email transporter configuration error:', {
                        message: error.message,
                        code: error.code,
                        command: error.command
                    });
                } else {
                    console.log('Email transporter ready and verified');
                }
            });
        }

        return emailTransporter;

    } catch (error) {
        console.error('Error creating email transporter:', error);
        throw new Error(`Failed to initialize email service: ${error.message}`);
    }
};


const testEmailConfiguration = async () => {
    try {
        const transporter = getEmailTransporter();
        await transporter.verify();
        console.log('Email configuration test passed');
        return true;
    } catch (error) {
        console.error('Email configuration test failed:', error);
        return false;
    }
};


export{sendEmail , getEmailTransporter , testEmailConfiguration};
