import mongoose, { Schema, model } from "mongoose";

const feedbackSchema = new Schema(
    {
        fromManagerId: {
            type: mongoose.Schema.Types.ObjectId,
            ref: 'User',
            required: [true, 'Manager ID is required']
        },
        toEmployeeId: {
            type: mongoose.Schema.Types.ObjectId,
            ref: 'User',
            required: [true, 'Employee ID is required']
        },
        strengths: {
            type: String,
            required: [true, 'Strengths field is required'],
            trim: true,
            maxlength: [1000, 'Strengths cannot exceed 1000 characters']
        },
        areasToImprove: {
            type: String,
            required: [true, 'Areas to improve field is required'],
            trim: true,
            maxlength: [1000, 'Areas to improve cannot exceed 1000 characters']
        },
        sentiment: {
            type: String,
            required: [true, 'Sentiment is required'],
            enum: {
                values: ['positive', 'neutral', 'negative'],
                message: 'Sentiment must be positive, neutral, or negative'
            }
        },
        isAcknowledged: {
            type: Boolean,
            default: false
        },
        acknowledgedAt: {
            type: Date,
            default: null
        },
        version: {
            type: Number,
            default: 1
        },
        isDeleted: {
            type: Boolean,
            default: false
        }
    },

    { timestamps: true }

)

feedbackSchema.pre("save", function (next) {
    if (this.isModified() && !this.isNew) {
        this.version += 1;
    }
    next();
})

const Feedback = model("Feedback" , feedbackSchema);
export{Feedback};
