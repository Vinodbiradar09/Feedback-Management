import mongoose, { Schema, model } from "mongoose";

const teamSchema = new Schema(
    {
        managerId: {
            type: mongoose.Schema.Types.ObjectId,
            ref: 'User',
            required: [true, 'Manager ID is required'],
            index : true
        },
        employeeIds: [{
            type: mongoose.Schema.Types.ObjectId,
            ref: 'User',
            validate: {
                validator: function (employeeIds) {
                    return employeeIds.length > 0;
                },
                message: 'Team must have at least one employee'
            },
            index : true
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

const Team = model("Team" , teamSchema);
export{Team};