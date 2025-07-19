import mongoose, { Schema, model } from "mongoose";
import mongooseAggregatePaginate from "mongoose-aggregate-paginate-v2";

const teamSchema = new Schema(
    {
        managerId: {
            type: mongoose.Schema.Types.ObjectId,
            ref: 'User',
            required: [true, 'Manager ID is required'],
            index: true
        },
        employeeIds: [{
            type: mongoose.Schema.Types.ObjectId,
            ref: 'User',
            index: true
        }],
        teamName: {
            type: String,
            required: [true, 'Team name is required'],
            trim: true,
            maxlength: [100, 'Team name cannot exceed 100 characters']
        },
        isActive: {
            type: Boolean,
            default: true
        }
    },

    { timestamps: true }
)
teamSchema.plugin(mongooseAggregatePaginate);
const Team = model("Team", teamSchema);
export { Team };