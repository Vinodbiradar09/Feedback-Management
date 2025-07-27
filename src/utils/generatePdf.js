import PDFDocument from "pdfkit";

const generateEmployeeFeedbackPDF = async (feedbacks, employeeName, employeeEmail) => {
    return new Promise((resolve, reject) => {
        try {
         
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

         
            try {
            
                doc.fontSize(20)
                    .fillColor('#2c3e50')
                    .text('Employee Feedback Report', { align: 'center' });

                doc.fontSize(12)
                    .fillColor('#7f8c8d')
                    .text(`Generated on: ${new Date().toLocaleDateString()}`, { align: 'center' });

                doc.moveDown(2);

              
                doc.fontSize(14)
                    .fillColor("#34495e")
                    .text(`Employee: ${employeeName}`, { underline: true });

                doc.fontSize(10)
                    .fillColor('#7f8c8d')
                    .text(`Email: ${employeeEmail}`);

                doc.fontSize(10)
                    .text(`Total Feedback Records: ${feedbacks.length}`);

                doc.moveDown(2);

              
                const sentimentCounts = feedbacks.reduce((acc, fb) => {
                    const sentiment = fb.sentiment || 'unknown';
                    acc[sentiment] = (acc[sentiment] || 0) + 1;
                    return acc;
                }, {});

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

        
                feedbacks.forEach((fb, idx) => {
                    try {
                      
                        if (doc.y > 700) {
                            doc.addPage();
                        }

                      
                        doc.fontSize(12)
                            .fillColor('#2c3e50')
                            .text(`Feedback #${idx + 1}`, { underline: true });

                        doc.moveDown(0.5);

                       
                        const sentiment = fb.sentiment || 'unknown';
                        const sentimentColor = sentiment === "positive" ? '#27ae60' :
                            sentiment === 'neutral' ? '#f39c12' : 
                            sentiment === 'negative' ? '#e74c3c' : '#95a5a6';

                        doc.fontSize(10)
                            .fillColor(sentimentColor)
                            .text(`Sentiment: ${sentiment.toUpperCase()}`);

                      
                        doc.fontSize(10)
                            .fillColor('#2c3e50')
                            .text('Strengths:', { continued: false });

                        doc.fontSize(9)
                            .fillColor('#34495e')
                            .text(fb.strengths || 'No strengths provided', { indent: 20 });

                     
                        doc.fontSize(10)
                            .fillColor('#2c3e50')
                            .text('Areas to Improve:', { continued: false });

                        doc.fontSize(9)
                            .fillColor('#34495e')
                            .text(fb.areasToImprove || 'No areas to improve provided', { indent: 20 });

                       
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

                       
                        const acknowledgedDate = fb.acknowledgedAt ? new Date(fb.acknowledgedAt).toLocaleDateString() : 'Not acknowledged';
                        const createdDate = fb.createdAt ? new Date(fb.createdAt).toLocaleDateString() : 'Unknown';

                        doc.fontSize(9)
                            .fillColor('#7f8c8d')
                            .text(`Acknowledged: ${acknowledgedDate}`);

                        doc.text(`Created: ${createdDate}`);

                     
                        doc.moveTo(50, doc.y + 10)
                           .lineTo(550, doc.y + 10)
                           .strokeColor('#ecf0f1')
                           .lineWidth(1)
                           .stroke();

                        doc.moveDown(1.5);

                    } catch (feedbackError) {
                        console.error(`Error processing feedback #${idx + 1}:`, feedbackError);
                       
                        doc.fontSize(9)
                            .fillColor('#e74c3c')
                            .text(`Error processing feedback #${idx + 1}`);
                        doc.moveDown(1);
                    }
                });

              
                doc.fontSize(8)
                   .fillColor('#95a5a6')
                   .text('This report is confidential and generated automatically.', 
                         50, doc.page.height - 50, { align: 'center' });

              
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

const generateManagerFeedbackPDF = async (feedbacks, managerName, managerEmail) => {
    return new Promise((resolve, reject) => {
        try {
            const doc = new PDFDocument({
                size: 'A4',
                margin: 50,
                bufferPages: true,
                info: {
                    Title: `Manager Feedback Export - ${managerName}`,
                    Author: 'Company Feedback System',
                    Subject: 'Manager Feedback Export Report',
                    CreationDate: new Date()
                }
            });

            const buffers = [];
            
            doc.on('data', buffers.push.bind(buffers));
            doc.on('end', () => {
                const pdfBuffer = Buffer.concat(buffers);
                resolve(pdfBuffer);
            });
            doc.on('error', reject);

            doc.fontSize(20)
               .fillColor('#2c3e50')
               .text('Manager Feedback Export Report', { align: 'center' });
            
            doc.fontSize(12)
               .fillColor('#7f8c8d')
               .text(`Generated on: ${new Date().toLocaleString()}`, { align: 'center' });
            
            doc.moveDown(2);

            doc.fontSize(14)
               .fillColor('#34495e')
               .text(`Manager: ${managerName}`, { underline: true });
            
            doc.fontSize(10)
               .fillColor('#7f8c8d')
               .text(`Email: ${managerEmail}`);
            
            doc.fontSize(10)
               .text(`Total Feedback Given: ${feedbacks.length}`);
            
            doc.moveDown(2);

            const sentimentCounts = feedbacks.reduce((acc, fb) => {
                acc[fb.sentiment] = (acc[fb.sentiment] || 0) + 1;
                return acc;
            }, {});

            const uniqueEmployees = new Set(feedbacks.map(fb => fb.toEmployeeId._id.toString())).size;

            doc.fontSize(12)
               .fillColor('#2c3e50')
               .text('Export Summary:', { underline: true });
            
            doc.fontSize(10)
               .fillColor('#34495e')
               .text(`Unique Employees: ${uniqueEmployees}`);
            
            doc.fillColor('#27ae60')
               .text(`✓ Positive Feedback: ${sentimentCounts.positive || 0}`);
            
            doc.fillColor('#f39c12')
               .text(`◐ Neutral Feedback: ${sentimentCounts.neutral || 0}`);
            
            doc.fillColor('#e74c3c')
               .text(`✗ Negative Feedback: ${sentimentCounts.negative || 0}`);
            
            doc.moveDown(2);

            const feedbacksByEmployee = feedbacks.reduce((acc, feedback) => {
                const employeeId = feedback.toEmployeeId._id.toString();
                if (!acc[employeeId]) {
                    acc[employeeId] = {
                        employee: feedback.toEmployeeId,
                        feedbacks: []
                    };
                }
                acc[employeeId].feedbacks.push(feedback);
                return acc;
            }, {});

            Object.values(feedbacksByEmployee).forEach((employeeGroup, empIndex) => {
               
                if (doc.y > 650) {
                    doc.addPage();
                }

                doc.fontSize(14)
                   .fillColor('#2c3e50')
                   .text(`Employee ${empIndex + 1}: ${employeeGroup.employee.name || employeeGroup.employee.fullName}`, { underline: true });
                
                doc.fontSize(10)
                   .fillColor('#7f8c8d')
                   .text(`Email: ${employeeGroup.employee.email}`);
                
                doc.fontSize(9)
                   .text(`Total Feedback Given: ${employeeGroup.feedbacks.length}`);
                
                doc.moveDown(1);

                employeeGroup.feedbacks.forEach((feedback, fbIndex) => {
                    if (doc.y > 700) {
                        doc.addPage();
                    }

                    doc.fontSize(11)
                       .fillColor('#34495e')
                       .text(`Feedback ${fbIndex + 1}:`, { indent: 20 });

                    const sentimentColor = feedback.sentiment === 'positive' ? '#27ae60' : 
                                         feedback.sentiment === 'neutral' ? '#f39c12' : '#e74c3c';
                    
                    doc.fontSize(9)
                       .fillColor(sentimentColor)
                       .text(`Sentiment: ${feedback.sentiment.toUpperCase()}`, { indent: 20 });

                    doc.fontSize(9)
                       .fillColor('#2c3e50')
                       .text('Strengths:', { indent: 20 });
                    
                    doc.fontSize(8)
                       .fillColor('#34495e')
                       .text(feedback.strengths, { indent: 40 });

                    doc.fontSize(9)
                       .fillColor('#2c3e50')
                       .text('Areas to Improve:', { indent: 20 });
                    
                    doc.fontSize(8)
                       .fillColor('#34495e')
                       .text(feedback.areasToImprove, { indent: 40 });

                    doc.fontSize(8)
                       .fillColor('#7f8c8d')
                       .text(`Given: ${new Date(feedback.createdAt).toLocaleDateString()}`, { indent: 20 });
                    
                    doc.text(`Acknowledged: ${new Date(feedback.acknowledgedAt).toLocaleDateString()}`, { indent: 20 });

                    doc.moveDown(0.5);
                });
                doc.moveTo(50, doc.y + 5)
                   .lineTo(550, doc.y + 5)
                   .strokeColor('#bdc3c7')
                   .lineWidth(1)
                   .stroke();

                doc.moveDown(1);
            });
            doc.fontSize(8)
               .fillColor('#95a5a6')
               .text('This report is confidential and for internal use only.', 
                     50, doc.page.height - 50, { align: 'center' });

            doc.end();

        } catch (error) {
            reject(error);
        }
    });
};

export { generateEmployeeFeedbackPDF, generateManagerFeedbackPDF };