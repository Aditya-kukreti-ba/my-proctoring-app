import React, { useState, useRef, useEffect } from 'react';
import { Camera, AlertTriangle, CheckCircle, Eye, Activity, Download, EyeOff } from 'lucide-react';

export default function LiveProctoring() {
  const [stream, setStream] = useState(null);
  const [isMonitoring, setIsMonitoring] = useState(false);
  const [detections, setDetections] = useState(null);
  const [violations, setViolations] = useState([]);
  const [stats, setStats] = useState({ scans: 0, violations: 0, uptime: 0 });
  const [error, setError] = useState(null);
  const [isAnalyzing, setIsAnalyzing] = useState(false);
  const [modelLoaded, setModelLoaded] = useState(false);
  const [faceModelLoaded, setFaceModelLoaded] = useState(false);
  const [loadingProgress, setLoadingProgress] = useState('Initializing...');
  const [headPose, setHeadPose] = useState(null);
  const [lookingAwayCount, setLookingAwayCount] = useState(0);
  
  const videoRef = useRef(null);
  const canvasRef = useRef(null);
  const monitoringIntervalRef = useRef(null);
  const startTimeRef = useRef(null);
  const cocoModelRef = useRef(null);
  const faceApiRef = useRef(null);
  const lookingAwayTimeRef = useRef(0);

  useEffect(() => {
    loadModels();
    return () => {
      stopMonitoring();
    };
  }, []);

  const loadModels = async () => {
    try {
      // Load COCO-SSD for object detection
      setLoadingProgress('Loading TensorFlow.js...');
      await import('@tensorflow/tfjs');
      
      setLoadingProgress('Loading object detection model...');
      const cocoSsd = await import('@tensorflow-models/coco-ssd');
      cocoModelRef.current = await cocoSsd.load();
      setModelLoaded(true);
      console.log('✅ COCO-SSD model loaded');
      
      // Load face-api.js for head pose detection - using maintained fork
      setLoadingProgress('Loading face detection library...');
      const faceapi = await import('@vladmandic/face-api');
      faceApiRef.current = faceapi;
      
      // Load face detection models
      setLoadingProgress('Loading face detection models...');
      const MODEL_URL = 'https://cdn.jsdelivr.net/npm/@vladmandic/face-api/model';
      
      await Promise.all([
        faceapi.nets.tinyFaceDetector.loadFromUri(MODEL_URL),
        faceapi.nets.faceLandmark68Net.loadFromUri(MODEL_URL)
      ]);
      
      setFaceModelLoaded(true);
      setLoadingProgress('All models loaded! Ready to start.');
      console.log('✅ Face detection models loaded');
      
    } catch (err) {
      console.error('Error loading models:', err);
      setError('Failed to load AI models. Please refresh the page.');
    }
  };

  const startCamera = async () => {
    try {
      const mediaStream = await navigator.mediaDevices.getUserMedia({
        video: { width: 1280, height: 720, facingMode: 'user' }
      });
      setStream(mediaStream);
      if (videoRef.current) {
        videoRef.current.srcObject = mediaStream;
      }
      setError(null);
    } catch (err) {
      setError('Camera access denied. Please allow camera permissions.');
      console.error('Camera error:', err);
    }
  };

  const stopCamera = () => {
    if (stream) {
      stream.getTracks().forEach(track => track.stop());
      setStream(null);
    }
  };

  const analyzeHeadPose = async () => {
    if (!faceApiRef.current || !videoRef.current) return null;

    try {
      const detections = await faceApiRef.current
        .detectAllFaces(videoRef.current, new faceApiRef.current.TinyFaceDetectorOptions())
        .withFaceLandmarks();

      if (detections.length === 0) {
        return { faceDetected: false, lookingAway: true, direction: 'No face detected' };
      }

      const landmarks = detections[0].landmarks;
      
      // Get key facial points
      const nose = landmarks.getNose();
      const leftEye = landmarks.getLeftEye();
      const rightEye = landmarks.getRightEye();
      
      // Calculate center points
      const noseTip = nose[3]; // Tip of nose
      const leftEyeCenter = leftEye[0];
      const rightEyeCenter = rightEye[3];
      const faceCenter = {
        x: (leftEyeCenter.x + rightEyeCenter.x) / 2,
        y: (leftEyeCenter.y + rightEyeCenter.y) / 2
      };
      
      // Calculate horizontal deviation (left/right)
      const horizontalDeviation = (noseTip.x - faceCenter.x) / (rightEyeCenter.x - leftEyeCenter.x);
      
      // Calculate vertical deviation (up/down)
      const verticalDeviation = (noseTip.y - faceCenter.y) / (rightEyeCenter.x - leftEyeCenter.x);
      
      // Determine if looking away
      let lookingAway = false;
      let direction = 'Looking at screen';
      
      // Thresholds for detection
      const horizontalThreshold = 0.3;
      const verticalThreshold = 0.4;
      
      if (Math.abs(horizontalDeviation) > horizontalThreshold) {
        lookingAway = true;
        direction = horizontalDeviation > 0 ? 'Looking right' : 'Looking left';
      } else if (verticalDeviation > verticalThreshold) {
        lookingAway = true;
        direction = 'Looking down';
      } else if (verticalDeviation < -verticalThreshold) {
        lookingAway = true;
        direction = 'Looking up';
      }
      
      return {
        faceDetected: true,
        lookingAway,
        direction,
        horizontalDeviation: horizontalDeviation.toFixed(2),
        verticalDeviation: verticalDeviation.toFixed(2),
        confidence: detections[0].detection.score
      };
      
    } catch (err) {
      console.error('Head pose analysis error:', err);
      return null;
    }
  };

  const analyzeFrame = async () => {
    if (!cocoModelRef.current || !videoRef.current) return;

    setIsAnalyzing(true);
    
    try {
      // Run object detection
      const predictions = await cocoModelRef.current.detect(videoRef.current);
      
      // Run head pose detection
      const headPoseResult = await analyzeHeadPose();
      setHeadPose(headPoseResult);
      
      // Process object predictions
      let peopleCount = 0;
      const prohibitedObjects = [];
      const allDetections = [];
      
      predictions.forEach(prediction => {
        const label = prediction.class.toLowerCase();
        const confidence = Math.round(prediction.score * 100);
        
        allDetections.push({
          label: prediction.class,
          confidence: confidence + '%',
          score: prediction.score
        });
        
        // Count people
        if (label === 'person') {
          peopleCount++;
        }
        
        // Check for prohibited objects
        if (prediction.score > 0.4) {
          const prohibitedKeywords = [
            'cell phone', 'phone', 'mobile',
            'book',
            'laptop', 'computer',
            'tv', 'monitor',
            'keyboard', 'mouse',
            'remote'
          ];
          
          prohibitedKeywords.forEach(keyword => {
            if (label.includes(keyword)) {
              prohibitedObjects.push(prediction.class);
            }
          });
        }
      });
      
      // Remove duplicates
      const uniqueProhibited = [...new Set(prohibitedObjects)];
      
      // Determine overall status
      const hasViolation = 
        peopleCount !== 1 || 
        uniqueProhibited.length > 0 || 
        (headPoseResult && headPoseResult.lookingAway);
      
      const analysis = {
        people_count: peopleCount,
        student_visible: peopleCount === 1,
        prohibited_objects: uniqueProhibited,
        concerns: [],
        status: hasViolation ? 'violation' : 'clear',
        raw_detections: allDetections.filter(d => d.score > 0.4).slice(0, 10),
        head_pose: headPoseResult
      };
      
      setDetections(analysis);
      setStats(prev => ({ ...prev, scans: prev.scans + 1 }));
      setError(null);
      
      // Check for violations
      const newViolations = [];
      const timestamp = new Date().toLocaleTimeString();
      
      if (analysis.people_count === 0) {
        newViolations.push({ 
          time: timestamp, 
          type: 'No student detected in frame', 
          severity: 'high' 
        });
      } else if (analysis.people_count > 1) {
        newViolations.push({ 
          time: timestamp, 
          type: `Multiple people detected (${analysis.people_count})`, 
          severity: 'critical' 
        });
      }
      
      if (uniqueProhibited.length > 0) {
        uniqueProhibited.forEach(obj => {
          newViolations.push({ 
            time: timestamp, 
            type: `Prohibited object: ${obj}`, 
            severity: 'high' 
          });
        });
      }
      
      // Head pose violations
      if (headPoseResult && headPoseResult.lookingAway) {
        lookingAwayTimeRef.current += 3;
        
        if (lookingAwayTimeRef.current >= 6) {
          newViolations.push({ 
            time: timestamp, 
            type: `Student looking away: ${headPoseResult.direction}`, 
            severity: 'medium' 
          });
          setLookingAwayCount(prev => prev + 1);
        }
      } else {
        lookingAwayTimeRef.current = 0;
      }
      
      if (newViolations.length > 0) {
        setViolations(prev => [...newViolations, ...prev].slice(0, 20));
        setStats(prev => ({ ...prev, violations: prev.violations + newViolations.length }));
      }
      
    } catch (err) {
      console.error('Analysis error:', err);
      setError(`Analysis failed: ${err.message}`);
    } finally {
      setIsAnalyzing(false);
    }
  };

  const startMonitoring = async () => {
    if (!modelLoaded || !faceModelLoaded) {
      setError('AI models are still loading. Please wait...');
      return;
    }

    await startCamera();
    setIsMonitoring(true);
    startTimeRef.current = Date.now();
    lookingAwayTimeRef.current = 0;
    
    const uptimeInterval = setInterval(() => {
      if (startTimeRef.current) {
        const seconds = Math.floor((Date.now() - startTimeRef.current) / 1000);
        setStats(prev => ({ ...prev, uptime: seconds }));
      }
    }, 1000);
    
    monitoringIntervalRef.current = setInterval(() => {
      analyzeFrame();
    }, 3000);
    
    setTimeout(() => {
      analyzeFrame();
    }, 1000);
    
    monitoringIntervalRef.uptimeInterval = uptimeInterval;
  };

  const stopMonitoring = () => {
    setIsMonitoring(false);
    stopCamera();
    if (monitoringIntervalRef.current) {
      clearInterval(monitoringIntervalRef.current);
      if (monitoringIntervalRef.uptimeInterval) {
        clearInterval(monitoringIntervalRef.uptimeInterval);
      }
    }
    startTimeRef.current = null;
    lookingAwayTimeRef.current = 0;
  };

  const formatUptime = (seconds) => {
    const hrs = Math.floor(seconds / 3600);
    const mins = Math.floor((seconds % 3600) / 60);
    const secs = seconds % 60;
    return `${hrs.toString().padStart(2, '0')}:${mins.toString().padStart(2, '0')}:${secs.toString().padStart(2, '0')}`;
  };

  const getSeverityColor = (severity) => {
    switch (severity) {
      case 'critical': return 'rgb(239, 68, 68)';
      case 'high': return 'rgb(249, 115, 22)';
      case 'medium': return 'rgb(234, 179, 8)';
      default: return 'rgb(234, 179, 8)';
    }
  };

  return (
    <div style={{
      minHeight: '100vh',
      background: 'linear-gradient(135deg, #0f172a 0%, #1e293b 50%, #334155 100%)',
      color: '#e2e8f0',
      fontFamily: '"JetBrains Mono", "Courier New", monospace',
      padding: '2rem',
      position: 'relative',
      overflow: 'hidden'
    }}>
      <div style={{
        position: 'absolute',
        top: 0,
        left: 0,
        right: 0,
        bottom: 0,
        backgroundImage: `
          linear-gradient(rgba(59, 130, 246, 0.05) 1px, transparent 1px),
          linear-gradient(90deg, rgba(59, 130, 246, 0.05) 1px, transparent 1px)
        `,
        backgroundSize: '50px 50px',
        opacity: 0.3,
        animation: 'gridMove 20s linear infinite'
      }} />

      <style>{`
        @keyframes gridMove {
          0% { transform: translate(0, 0); }
          100% { transform: translate(50px, 50px); }
        }
        @keyframes pulse {
          0%, 100% { opacity: 1; }
          50% { opacity: 0.5; }
        }
        @keyframes slideUp {
          from { transform: translateY(20px); opacity: 0; }
          to { transform: translateY(0); opacity: 1; }
        }
        @keyframes spin {
          from { transform: rotate(0deg); }
          to { transform: rotate(360deg); }
        }
        .stat-card {
          animation: slideUp 0.5s ease-out;
        }
      `}</style>

      <div style={{ position: 'relative', maxWidth: '1600px', margin: '0 auto' }}>
        <div style={{
          marginBottom: '2rem',
          textAlign: 'center',
          animation: 'slideUp 0.6s ease-out'
        }}>
          <div style={{
            display: 'inline-flex',
            alignItems: 'center',
            gap: '1rem',
            marginBottom: '0.5rem'
          }}>
            <Eye size={40} color="#3b82f6" />
            <h1 style={{
              fontSize: '3rem',
              fontWeight: '700',
              margin: 0,
              background: 'linear-gradient(135deg, #3b82f6 0%, #8b5cf6 100%)',
              WebkitBackgroundClip: 'text',
              WebkitTextFillColor: 'transparent',
              letterSpacing: '-0.02em'
            }}>
              AI PROCTORING SYSTEM
            </h1>
          </div>
          <p style={{
            fontSize: '1rem',
            color: '#94a3b8',
            margin: 0,
            letterSpacing: '0.1em',
            textTransform: 'uppercase'
          }}>
            Live Object Detection & Head Pose Tracking
          </p>
          {(!modelLoaded || !faceModelLoaded) && (
            <div style={{
              marginTop: '1rem',
              padding: '0.75rem',
              background: 'rgba(59, 130, 246, 0.2)',
              border: '1px solid rgba(59, 130, 246, 0.3)',
              borderRadius: '8px',
              color: '#60a5fa',
              display: 'inline-flex',
              alignItems: 'center',
              gap: '0.5rem'
            }}>
              <Download size={16} />
              {loadingProgress}
            </div>
          )}
        </div>

        {error && (
          <div style={{
            marginBottom: '1rem',
            padding: '1rem',
            background: 'rgba(239, 68, 68, 0.2)',
            border: '1px solid rgba(239, 68, 68, 0.5)',
            borderRadius: '8px',
            color: '#ef4444',
            display: 'flex',
            alignItems: 'center',
            gap: '0.5rem'
          }}>
            <AlertTriangle size={20} />
            {error}
          </div>
        )}

        <div style={{
          display: 'grid',
          gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))',
          gap: '1rem',
          marginBottom: '2rem'
        }}>
          <div className="stat-card" style={{
            background: 'rgba(15, 23, 42, 0.6)',
            border: '1px solid rgba(59, 130, 246, 0.3)',
            borderRadius: '12px',
            padding: '1.5rem',
            backdropFilter: 'blur(10px)',
            animationDelay: '0.1s'
          }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: '0.75rem', marginBottom: '0.5rem' }}>
              <Activity size={20} color="#3b82f6" />
              <span style={{ fontSize: '0.75rem', color: '#94a3b8', textTransform: 'uppercase', letterSpacing: '0.05em' }}>Uptime</span>
            </div>
            <div style={{ fontSize: '1.75rem', fontWeight: '700', color: '#3b82f6' }}>
              {formatUptime(stats.uptime)}
            </div>
          </div>

          <div className="stat-card" style={{
            background: 'rgba(15, 23, 42, 0.6)',
            border: '1px solid rgba(34, 197, 94, 0.3)',
            borderRadius: '12px',
            padding: '1.5rem',
            backdropFilter: 'blur(10px)',
            animationDelay: '0.2s'
          }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: '0.75rem', marginBottom: '0.5rem' }}>
              <Camera size={20} color="#22c55e" />
              <span style={{ fontSize: '0.75rem', color: '#94a3b8', textTransform: 'uppercase', letterSpacing: '0.05em' }}>Scans</span>
            </div>
            <div style={{ fontSize: '1.75rem', fontWeight: '700', color: '#22c55e', display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
              {stats.scans}
              {isAnalyzing && (
                <div style={{
                  width: '20px',
                  height: '20px',
                  border: '2px solid rgba(34, 197, 94, 0.3)',
                  borderTopColor: '#22c55e',
                  borderRadius: '50%',
                  animation: 'spin 1s linear infinite'
                }} />
              )}
            </div>
          </div>

          <div className="stat-card" style={{
            background: 'rgba(15, 23, 42, 0.6)',
            border: '1px solid rgba(234, 179, 8, 0.3)',
            borderRadius: '12px',
            padding: '1.5rem',
            backdropFilter: 'blur(10px)',
            animationDelay: '0.25s'
          }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: '0.75rem', marginBottom: '0.5rem' }}>
              <EyeOff size={20} color="#eab308" />
              <span style={{ fontSize: '0.75rem', color: '#94a3b8', textTransform: 'uppercase', letterSpacing: '0.05em' }}>Looking Away</span>
            </div>
            <div style={{ fontSize: '1.75rem', fontWeight: '700', color: '#eab308' }}>
              {lookingAwayCount}
            </div>
          </div>

          <div className="stat-card" style={{
            background: 'rgba(15, 23, 42, 0.6)',
            border: '1px solid rgba(239, 68, 68, 0.3)',
            borderRadius: '12px',
            padding: '1.5rem',
            backdropFilter: 'blur(10px)',
            animationDelay: '0.3s'
          }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: '0.75rem', marginBottom: '0.5rem' }}>
              <AlertTriangle size={20} color="#ef4444" />
              <span style={{ fontSize: '0.75rem', color: '#94a3b8', textTransform: 'uppercase', letterSpacing: '0.05em' }}>Violations</span>
            </div>
            <div style={{ fontSize: '1.75rem', fontWeight: '700', color: '#ef4444' }}>
              {stats.violations}
            </div>
          </div>

          <div className="stat-card" style={{
            background: 'rgba(15, 23, 42, 0.6)',
            border: detections?.status === 'clear' ? '1px solid rgba(34, 197, 94, 0.3)' : '1px solid rgba(239, 68, 68, 0.3)',
            borderRadius: '12px',
            padding: '1.5rem',
            backdropFilter: 'blur(10px)',
            animationDelay: '0.4s'
          }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: '0.75rem', marginBottom: '0.5rem' }}>
              {detections?.status === 'clear' ? (
                <CheckCircle size={20} color="#22c55e" />
              ) : (
                <AlertTriangle size={20} color="#ef4444" />
              )}
              <span style={{ fontSize: '0.75rem', color: '#94a3b8', textTransform: 'uppercase', letterSpacing: '0.05em' }}>Status</span>
            </div>
            <div style={{
              fontSize: '1.25rem',
              fontWeight: '700',
              color: detections?.status === 'clear' ? '#22c55e' : '#ef4444',
              textTransform: 'uppercase'
            }}>
              {isMonitoring ? (detections?.status || 'SCANNING...') : 'OFFLINE'}
            </div>
          </div>
        </div>

        <div style={{
          display: 'grid',
          gridTemplateColumns: '2fr 1fr',
          gap: '2rem',
          alignItems: 'start'
        }}>
          <div style={{
            background: 'rgba(15, 23, 42, 0.6)',
            border: '1px solid rgba(59, 130, 246, 0.3)',
            borderRadius: '16px',
            padding: '1.5rem',
            backdropFilter: 'blur(10px)',
            animation: 'slideUp 0.7s ease-out'
          }}>
            <div style={{
              display: 'flex',
              justifyContent: 'space-between',
              alignItems: 'center',
              marginBottom: '1rem'
            }}>
              <h2 style={{
                fontSize: '1.25rem',
                fontWeight: '600',
                margin: 0,
                display: 'flex',
                alignItems: 'center',
                gap: '0.5rem'
              }}>
                <Camera size={20} />
                LIVE FEED
                {isMonitoring && (
                  <span style={{
                    width: '8px',
                    height: '8px',
                    borderRadius: '50%',
                    background: '#ef4444',
                    animation: 'pulse 2s infinite',
                    marginLeft: '0.5rem'
                  }} />
                )}
              </h2>
              {!isMonitoring ? (
                <button
                  onClick={startMonitoring}
                  disabled={!modelLoaded || !faceModelLoaded}
                  style={{
                    background: (modelLoaded && faceModelLoaded) ? 'linear-gradient(135deg, #3b82f6 0%, #8b5cf6 100%)' : '#334155',
                    color: 'white',
                    border: 'none',
                    padding: '0.75rem 1.5rem',
                    borderRadius: '8px',
                    fontSize: '0.875rem',
                    fontWeight: '600',
                    cursor: (modelLoaded && faceModelLoaded) ? 'pointer' : 'not-allowed',
                    textTransform: 'uppercase',
                    letterSpacing: '0.05em',
                    transition: 'transform 0.2s',
                    fontFamily: 'inherit'
                  }}
                  onMouseOver={(e) => (modelLoaded && faceModelLoaded) && (e.target.style.transform = 'scale(1.05)')}
                  onMouseOut={(e) => e.target.style.transform = 'scale(1)'}
                >
                  {(modelLoaded && faceModelLoaded) ? 'Start Monitoring' : 'Loading AI...'}
                </button>
              ) : (
                <button
                  onClick={stopMonitoring}
                  style={{
                    background: 'rgba(239, 68, 68, 0.2)',
                    color: '#ef4444',
                    border: '1px solid #ef4444',
                    padding: '0.75rem 1.5rem',
                    borderRadius: '8px',
                    fontSize: '0.875rem',
                    fontWeight: '600',
                    cursor: 'pointer',
                    textTransform: 'uppercase',
                    letterSpacing: '0.05em',
                    transition: 'transform 0.2s',
                    fontFamily: 'inherit'
                  }}
                  onMouseOver={(e) => e.target.style.transform = 'scale(1.05)'}
                  onMouseOut={(e) => e.target.style.transform = 'scale(1)'}
                >
                  Stop Monitoring
                </button>
              )}
            </div>

            <div style={{
              position: 'relative',
              width: '100%',
              paddingBottom: '56.25%',
              background: '#000',
              borderRadius: '8px',
              overflow: 'hidden',
              border: '2px solid rgba(59, 130, 246, 0.3)'
            }}>
              <video
                ref={videoRef}
                autoPlay
                playsInline
                muted
                style={{
                  position: 'absolute',
                  top: 0,
                  left: 0,
                  width: '100%',
                  height: '100%',
                  objectFit: 'cover'
                }}
              />
              {!stream && (
                <div style={{
                  position: 'absolute',
                  top: '50%',
                  left: '50%',
                  transform: 'translate(-50%, -50%)',
                  textAlign: 'center',
                  color: '#64748b'
                }}>
                  <Camera size={48} style={{ marginBottom: '1rem' }} />
                  <p style={{ margin: 0, fontSize: '1.125rem' }}>Camera Inactive</p>
                </div>
              )}
              
              {headPose && headPose.faceDetected && (
                <div style={{
                  position: 'absolute',
                  top: '1rem',
                  left: '1rem',
                  background: headPose.lookingAway ? 'rgba(239, 68, 68, 0.9)' : 'rgba(34, 197, 94, 0.9)',
                  padding: '0.5rem 1rem',
                  borderRadius: '8px',
                  fontSize: '0.875rem',
                  fontWeight: '600',
                  display: 'flex',
                  alignItems: 'center',
                  gap: '0.5rem'
                }}>
                  {headPose.lookingAway ? <EyeOff size={16} /> : <Eye size={16} />}
                  {headPose.direction}
                </div>
              )}
            </div>
            <canvas ref={canvasRef} style={{ display: 'none' }} />

            {detections && (
              <div style={{
                marginTop: '1rem',
                padding: '1rem',
                background: 'rgba(0, 0, 0, 0.3)',
                borderRadius: '8px',
                border: '1px solid rgba(59, 130, 246, 0.2)'
              }}>
                <h3 style={{
                  fontSize: '0.875rem',
                  fontWeight: '600',
                  marginBottom: '0.75rem',
                  color: '#94a3b8',
                  textTransform: 'uppercase',
                  letterSpacing: '0.05em'
                }}>
                  Current Detection
                </h3>
                <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '0.75rem', fontSize: '0.875rem' }}>
                  <div>
                    <span style={{ color: '#64748b' }}>People: </span>
                    <span style={{ color: detections.people_count === 1 ? '#22c55e' : '#ef4444', fontWeight: '600' }}>
                      {detections.people_count}
                    </span>
                  </div>
                  <div>
                    <span style={{ color: '#64748b' }}>Student Visible: </span>
                    <span style={{ color: detections.student_visible ? '#22c55e' : '#ef4444', fontWeight: '600' }}>
                      {detections.student_visible ? 'YES' : 'NO'}
                    </span>
                  </div>
                  {headPose && headPose.faceDetected && (
                    <>
                      <div>
                        <span style={{ color: '#64748b' }}>Head Pose: </span>
                        <span style={{ color: headPose.lookingAway ? '#ef4444' : '#22c55e', fontWeight: '600' }}>
                          {headPose.direction}
                        </span>
                      </div>
                      <div>
                        <span style={{ color: '#64748b' }}>Eye Contact: </span>
                        <span style={{ color: headPose.lookingAway ? '#ef4444' : '#22c55e', fontWeight: '600' }}>
                          {headPose.lookingAway ? 'NO' : 'YES'}
                        </span>
                      </div>
                    </>
                  )}
                </div>
                {detections.prohibited_objects && detections.prohibited_objects.length > 0 && (
                  <div style={{ marginTop: '0.75rem' }}>
                    <span style={{ color: '#64748b', fontSize: '0.875rem' }}>Prohibited Objects: </span>
                    <span style={{ color: '#ef4444', fontWeight: '600', fontSize: '0.875rem' }}>
                      {detections.prohibited_objects.join(', ')}
                    </span>
                  </div>
                )}
                {detections.raw_detections && detections.raw_detections.length > 0 && (
                  <div style={{ marginTop: '0.75rem', fontSize: '0.75rem', color: '#64748b' }}>
                    <details>
                      <summary style={{ cursor: 'pointer', marginBottom: '0.5rem' }}>All Detections ({detections.raw_detections.length})</summary>
                      <div style={{ display: 'grid', gap: '0.25rem' }}>
                        {detections.raw_detections.map((d, i) => (
                          <div key={i}>• {d.label} ({d.confidence})</div>
                        ))}
                      </div>
                    </details>
                  </div>
                )}
              </div>
            )}
          </div>

          <div style={{
            background: 'rgba(15, 23, 42, 0.6)',
            border: '1px solid rgba(239, 68, 68, 0.3)',
            borderRadius: '16px',
            padding: '1.5rem',
            backdropFilter: 'blur(10px)',
            animation: 'slideUp 0.8s ease-out',
            maxHeight: '600px',
            overflow: 'hidden',
            display: 'flex',
            flexDirection: 'column'
          }}>
            <h2 style={{
              fontSize: '1.25rem',
              fontWeight: '600',
              margin: 0,
              marginBottom: '1rem',
              display: 'flex',
              alignItems: 'center',
              gap: '0.5rem'
            }}>
              <AlertTriangle size={20} color="#ef4444" />
              VIOLATION LOG
            </h2>

            <div style={{
              flex: 1,
              overflowY: 'auto',
              paddingRight: '0.5rem'
            }}>
              {violations.length === 0 ? (
                <div style={{
                  textAlign: 'center',
                  padding: '3rem 1rem',
                  color: '#64748b'
                }}>
                  <CheckCircle size={48} style={{ marginBottom: '1rem', opacity: 0.5 }} />
                  <p style={{ margin: 0, fontSize: '0.875rem' }}>No violations detected</p>
                </div>
              ) : (
                violations.map((v, idx) => (
                  <div
                    key={idx}
                    style={{
                      padding: '1rem',
                      background: 'rgba(0, 0, 0, 0.3)',
                      borderLeft: `4px solid ${getSeverityColor(v.severity)}`,
                      borderRadius: '6px',
                      marginBottom: '0.75rem',
                      animation: 'slideUp 0.3s ease-out'
                    }}
                  >
                    <div style={{
                      display: 'flex',
                      justifyContent: 'space-between',
                      alignItems: 'flex-start',
                      marginBottom: '0.25rem'
                    }}>
                      <span style={{
                        fontSize: '0.75rem',
                        color: getSeverityColor(v.severity),
                        fontWeight: '600',
                        textTransform: 'uppercase',
                        letterSpacing: '0.05em'
                      }}>
                        {v.severity}
                      </span>
                      <span style={{ fontSize: '0.75rem', color: '#64748b' }}>
                        {v.time}
                      </span>
                    </div>
                    <p style={{
                      margin: 0,
                      fontSize: '0.875rem',
                      color: '#e2e8f0'
                    }}>
                      {v.type}
                    </p>
                  </div>
                ))
              )}
            </div>
          </div>
        </div>

        <div style={{
          marginTop: '2rem',
          padding: '1.5rem',
          background: 'rgba(15, 23, 42, 0.4)',
          border: '1px solid rgba(59, 130, 246, 0.2)',
          borderRadius: '12px',
          backdropFilter: 'blur(10px)',
          animation: 'slideUp 0.9s ease-out'
        }}>
          <h3 style={{
            fontSize: '0.875rem',
            fontWeight: '600',
            marginBottom: '0.75rem',
            color: '#94a3b8',
            textTransform: 'uppercase',
            letterSpacing: '0.05em'
          }}>
            🤖 AI Detection Powered By
          </h3>
          <div style={{ display: 'grid', gap: '0.5rem', fontSize: '0.875rem' }}>
            <div style={{
              display: 'flex',
              alignItems: 'center',
              gap: '0.5rem',
              color: '#64748b'
            }}>
              <div style={{
                width: '8px',
                height: '8px',
                borderRadius: '50%',
                background: modelLoaded ? '#22c55e' : '#f59e0b'
              }} />
              <span><strong>COCO-SSD:</strong> Object & person detection</span>
            </div>
            <div style={{
              display: 'flex',
              alignItems: 'center',
              gap: '0.5rem',
              color: '#64748b'
            }}>
              <div style={{
                width: '8px',
                height: '8px',
                borderRadius: '50%',
                background: faceModelLoaded ? '#22c55e' : '#f59e0b'
              }} />
              <span><strong>Face-API.js:</strong> Head pose & gaze tracking</span>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
