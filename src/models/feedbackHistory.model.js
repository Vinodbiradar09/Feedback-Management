import mongoose, { Schema, model } from "mongoose";

const feedbackHistorySchema = new Schema(
    {
        feedbackId: {
            type: mongoose.Schema.Types.ObjectId,
            ref: 'Feedback',
            required: [true, 'Feedback ID is required'],
            index : true
        },
        previousData: {
            type: mongoose.Schema.Types.Mixed,
            required: [true, 'Previous data is required']
        },
        editedByManagersId: {
            type: mongoose.Schema.Types.ObjectId,
            ref: 'User',
            required: [true, 'Editor ID is required']
        },
        editReason: {
            type: String,
            trim: true,
            maxlength: [500, 'Edit reason cannot exceed 500 characters']
        },
        editedAt: {
            type: Date,
            default: Date.now
        }
    },
    { timestamps: true }

)

const Feedbackhistory = model("Feedbackhistory" , feedbackHistorySchema);
export{Feedbackhistory};

