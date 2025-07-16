import multer from "multer";


const storage = multer.diskStorage({
    destination: (req, file, cb) => {
        cb(null, "./public/temp")
    },
    filename: (req, file, cb) => {
        const uniqueFileName = file.originalname;
        cb(null, uniqueFileName);
    }
})

export const upload = multer({ storage: storage });

