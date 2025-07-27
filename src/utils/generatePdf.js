import PDFDocument from "pdfkit";

const generateEmployeeFeedbackPDF = async (feedbacks, employeeName, employeeEmail) => {
    return new Promise((resolve, reject) => {
        try {
            // Validate inputs
            if (!feedbacks || !Array.isArray(feedbacks) || feedbacks.length === 0) {
                return reject(new Error('No feedbacks provided or feedbacks is not an array'));
            }

            if (!employeeName || typeof employeeName !== 'string') {
                return reject(new Error('Invalid employee name provided'));
            }

            if (!employeeEmail || typeof employeeEmail !== 'string') {
                return reject(new Error('Invalid employee email provided'));
            }

            console.log(`Generating PDF for ${employeeName} with ${feedbacks.length} feedback records`);

            const doc = new PDFDocument({
                size: "A4",
                margin: 50,
                bufferPages: true,
                info: {
                    Title: `Feedback Report - ${employeeName}`,
                    Author: 'Company Feedback System',
                    Subject: 'Employee Feedback Report',
                    CreationDate: new Date()
                }
            });

            const buffers = [];

            // Handle document events
            doc.on("data", (chunk) => {
                buffers.push(chunk);
            });

            doc.on('end', () => {
                try {
                    const pdfBuffer = Buffer.concat(buffers);
                    console.log('PDF generation completed, buffer size:', pdfBuffer.length);
                    resolve(pdfBuffer);
                } catch (concatError) {
                    console.error('Error concatenating PDF buffers:', concatError);
                    reject(new Error('Failed to create PDF buffer'));
                }
            });

            doc.on('error', (error) => {
                console.error('PDF document error:', error);
                reject(new Error(`PDF generation failed: ${error.message}`));
            });

            // Generate PDF content
            try {
                // Header
                doc.fontSize(20)
                    .fillColor('#2c3e50')
                    .text('Employee Feedback Report', { align: 'center' });

                doc.fontSize(12)
                    .fillColor('#7f8c8d')
                    .text(`Generated on: ${new Date().toLocaleDateString()}`, { align: 'center' });

                doc.moveDown(2);

                // Employee details
                doc.fontSize(14)
                    .fillColor("#34495e")
                    .text(`Employee: ${employeeName}`, { underline: true });

                doc.fontSize(10)
                    .fillColor('#7f8c8d')
                    .text(`Email: ${employeeEmail}`);

                doc.fontSize(10)
                    .text(`Total Feedback Records: ${feedbacks.length}`);

                doc.moveDown(2);

                // Calculate sentiment summary
                const sentimentCounts = feedbacks.reduce((acc, fb) => {
                    const sentiment = fb.sentiment || 'unknown';
                    acc[sentiment] = (acc[sentiment] || 0) + 1;
                    return acc;
                }, {});

                // Feedback summary
                doc.fontSize(12)
                    .fillColor('#2c3e50')
                    .text('Feedback Summary:', { underline: true });

                doc.fontSize(10)
                    .fillColor('#27ae60')
                    .text(`✓ Positive: ${sentimentCounts.positive || 0}`);

                doc.fillColor('#f39c12')
                    .text(`◐ Neutral: ${sentimentCounts.neutral || 0}`);

                doc.fillColor('#e74c3c')
                    .text(`✗ Negative: ${sentimentCounts.negative || 0}`);

                if (sentimentCounts.unknown) {
                    doc.fillColor('#95a5a6')
                        .text(`? Unknown: ${sentimentCounts.unknown}`);
                }

                doc.moveDown(2);

                // Individual feedback records
                feedbacks.forEach((fb, idx) => {
                    try {
                        // Check if we need a new page
                        if (doc.y > 700) {
                            doc.addPage();
                        }

                        // Feedback header
                        doc.fontSize(12)
                            .fillColor('#2c3e50')
                            .text(`Feedback #${idx + 1}`, { underline: true });

                        doc.moveDown(0.5);

                        // Sentiment
                        const sentiment = fb.sentiment || 'unknown';
                        const sentimentColor = sentiment === "positive" ? '#27ae60' :
                            sentiment === 'neutral' ? '#f39c12' : 
                            sentiment === 'negative' ? '#e74c3c' : '#95a5a6';

                        doc.fontSize(10)
                            .fillColor(sentimentColor)
                            .text(`Sentiment: ${sentiment.toUpperCase()}`);

                        // Strengths
                        doc.fontSize(10)
                            .fillColor('#2c3e50')
                            .text('Strengths:', { continued: false });

                        doc.fontSize(9)
                            .fillColor('#34495e')
                            .text(fb.strengths || 'No strengths provided', { indent: 20 });

                        // Areas to improve
                        doc.fontSize(10)
                            .fillColor('#2c3e50')
                            .text('Areas to Improve:', { continued: false });

                        doc.fontSize(9)
                            .fillColor('#34495e')
                            .text(fb.areasToImprove || 'No areas to improve provided', { indent: 20 });

                        // Manager information
                        if (fb.fromManagerId && typeof fb.fromManagerId === 'object' && fb.fromManagerId.name) {
                            doc.fontSize(9)
                                .fillColor('#7f8c8d')
                                .text(`Manager: ${fb.fromManagerId.name} (${fb.fromManagerId.email || 'No email'})`);
                        } else if (fb.fromManagerId) {
                            doc.fontSize(9)
                                .fillColor('#7f8c8d')
                                .text(`Manager ID: ${fb.fromManagerId}`);
                        } else {
                            doc.fontSize(9)
                                .fillColor('#7f8c8d')
                                .text('Manager: Not specified');
                        }

                        // Dates
                        const acknowledgedDate = fb.acknowledgedAt ? new Date(fb.acknowledgedAt).toLocaleDateString() : 'Not acknowledged';
                        const createdDate = fb.createdAt ? new Date(fb.createdAt).toLocaleDateString() : 'Unknown';

                        doc.fontSize(9)
                            .fillColor('#7f8c8d')
                            .text(`Acknowledged: ${acknowledgedDate}`);

                        doc.text(`Created: ${createdDate}`);

                        // Separator line
                        doc.moveTo(50, doc.y + 10)
                           .lineTo(550, doc.y + 10)
                           .strokeColor('#ecf0f1')
                           .lineWidth(1)
                           .stroke();

                        doc.moveDown(1.5);

                    } catch (feedbackError) {
                        console.error(`Error processing feedback #${idx + 1}:`, feedbackError);
                        // Continue with next feedback item
                        doc.fontSize(9)
                            .fillColor('#e74c3c')
                            .text(`Error processing feedback #${idx + 1}`);
                        doc.moveDown(1);
                    }
                });

                // Footer
                doc.fontSize(8)
                   .fillColor('#95a5a6')
                   .text('This report is confidential and generated automatically.', 
                         50, doc.page.height - 50, { align: 'center' });

                // Finalize the document
                doc.end();

            } catch (contentError) {
                console.error('Error generating PDF content:', contentError);
                reject(new Error(`Failed to generate PDF content: ${contentError.message}`));
            }

        } catch (error) {
            console.error('PDF generation setup error:', error);
            reject(new Error(`PDF generation failed: ${error.message}`));
        }
    });
};

// Rate limiting with better error handling
const exportRateLimit = new Map();
const RATE_LIMIT_WINDOW = 60 * 60 * 1000; // 1 hour
const MAX_EXPORTS_PER_HOUR = 5;

const checkRateLimit = (userId) => {
    try {
        if (!userId) {
            console.error('checkRateLimit called without userId');
            return false;
        }

        const now = Date.now();
        const userKey = userId.toString();

        if (!exportRateLimit.has(userKey)) {
            exportRateLimit.set(userKey, { count: 1, resetTime: now + RATE_LIMIT_WINDOW });
            return true;
        }

        const userLimit = exportRateLimit.get(userKey);

        // Reset if window has passed
        if (now > userLimit.resetTime) {
            exportRateLimit.set(userKey, { count: 1, resetTime: now + RATE_LIMIT_WINDOW });
            return true;
        }

        // Check if limit exceeded
        if (userLimit.count >= MAX_EXPORTS_PER_HOUR) {
            return false;
        }

        // Increment count
        userLimit.count += 1;
        return true;

    } catch (error) {
        console.error('Error in checkRateLimit:', error);
        return false; // Fail safe - deny access if there's an error
    }
};

// Cleanup old rate limit entries periodically
setInterval(() => {
    const now = Date.now();
    for (const [key, value] of exportRateLimit.entries()) {
        if (now > value.resetTime) {
            exportRateLimit.delete(key);
        }
    }
}, RATE_LIMIT_WINDOW); // Clean up every hour

export { generateEmployeeFeedbackPDF, checkRateLimit };