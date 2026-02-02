import { useState, useEffect } from 'react';
import { BrowserRouter as Router, Routes, Route, Link, useParams } from 'react-router-dom';
import io from 'socket.io-client';
import './App.css';

interface Device {
  id: string;
  status: string;
}

interface Package {
  name: string;
}

interface ApkInfo {
  packageName: string;
  paths: string[];
}

function DeviceList() {
  const [devices, setDevices] = useState<Device[]>([]);
  const [loading, setLoading] = useState(false);

  const fetchDevices = async () => {
    setLoading(true);
    try {
      const response = await fetch('/api/adb/devices');
      const data = await response.json();
      setDevices(data.devices.map((id: string) => ({ id, status: 'available' })));
    } catch (error) {
      console.error('Error fetching devices:', error);
    }
    setLoading(false);
  };

  useEffect(() => {
    fetchDevices();
    const interval = setInterval(fetchDevices, 5000); // Poll every 5 seconds
    return () => clearInterval(interval);
  }, []);

  const handleRefresh = () => {
    fetchDevices();
  };

  return (
    <div className="app">
      <h1>APK Reverse Engineering Tool</h1>
      <div className="glass-card">
        <h2>Connected Devices</h2>
        {loading && <p>Loading devices...</p>}
        {!devices.length && !loading && (
          <p>Waiting for device connection...</p>
        )}
        <div className="device-list">
          {devices.map((device) => (
            <Link key={device.id} to={`/device/${device.id}`} className="device-card">
              <h3>{device.id}</h3>
              <p>{device.status}</p>
            </Link>
          ))}
        </div>
        <button className="button" onClick={handleRefresh} disabled={loading}>
          Refresh Devices
        </button>
      </div>
    </div>
  );
}

function DeviceDetail() {
  const { deviceId } = useParams<{ deviceId: string }>();
  const [packages, setPackages] = useState<Package[]>([]);
  const [selectedPackage, setSelectedPackage] = useState<ApkInfo | null>(null);
  const [loading, setLoading] = useState(false);

  const fetchPackages = async () => {
    setLoading(true);
    try {
      const response = await fetch(`/api/adb/packages?device=${deviceId}`);
      const data = await response.json();
      setPackages(data.packages.map((name: string) => ({ name })));
    } catch (error) {
      console.error('Error fetching packages:', error);
    }
    setLoading(false);
  };

  const fetchApkInfo = async (packageName: string) => {
    try {
      const response = await fetch(`/api/adb/paths?package=${packageName}&device=${deviceId}`);
      const data = await response.json();
      setSelectedPackage({ packageName, paths: data.paths });
    } catch (error) {
      console.error('Error fetching APK info:', error);
    }
  };

  const downloadApk = async () => {
    if (!selectedPackage) return;
    try {
      const response = await fetch('/api/adb/pull-package', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          packageName: selectedPackage.packageName,
          device: deviceId,
        }),
      });
      const data = await response.json();
      if (data.zipFilename) {
        const downloadUrl = `/api/adb/download/${data.zipFilename}`;
        window.open(downloadUrl, '_blank');
      }
    } catch (error) {
      console.error('Error downloading APK:', error);
    }
  };

  useEffect(() => {
    if (deviceId) fetchPackages();
  }, [deviceId]);

  return (
    <div className="app">
      <h1>Device: {deviceId}</h1>
      <div className="glass-card">
        <h2>Installed APKs</h2>
        {loading && <p>Loading packages...</p>}
        <div className="package-list">
          {packages.map((pkg) => (
            <Link key={pkg.name} to={`/device/${deviceId}/${pkg.name}`} className="package-card">
              <h4>{pkg.name}</h4>
            </Link>
          ))}
        </div>
        <Link to="/" className="button">Back to Devices</Link>
      </div>
    </div>
  );
}

function PackageTools() {
  const { deviceId, packageName } = useParams<{ deviceId: string; packageName: string }>();
  const [zipFilename, setZipFilename] = useState<string | null>(null);
  const [logs, setLogs] = useState<string[]>([]);
  const [processing, setProcessing] = useState<string | null>(null);
  const [isSplit, setIsSplit] = useState<boolean>(false);
  const socket = io('http://localhost:4000');

  useEffect(() => {
    socket.on(`log-${packageName}`, (message: string) => {
      setLogs(prev => [...prev, message]);
    });
    socket.on('log-system', (message: string) => {
      setLogs(prev => [...prev, message]);
    });
    return () => {
      socket.off(`log-${packageName}`);
      socket.off('log-system');
    };
  }, [packageName, socket]);

  useEffect(() => {
    // Fetch paths to determine if split
    fetch(`/api/adb/paths?package=${packageName}&device=${deviceId}`)
      .then(res => res.json())
      .then(data => {
        setIsSplit(data.paths.length > 1);
      });
  }, [packageName, deviceId]);

  const handleDownloadSplit = async () => {
    setProcessing('download-split');
    setLogs([]);
    try {
      const response = await fetch('/api/adb/pull-package', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          packageName,
          device: deviceId,
        }),
      });
      const data = await response.json();
      if (data.zipFilename) {
        downloadFile(data.zipFilename);
      }
    } catch (error) {
      console.error('Error downloading split APKs:', error);
    }
    setProcessing(null);
  };

  const handleBundleSingle = async () => {
    setProcessing('bundle-single');
    setLogs([]);
    try {
      const response = await fetch('/api/adb/bundle-single', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          packageName,
          device: deviceId,
        }),
      });
      const data = await response.json();
      if (data.zipFilename) {
        downloadFile(data.zipFilename);
      }
    } catch (error) {
      console.error('Error bundling to single APK:', error);
    }
    setProcessing(null);
  };

  const handleMitm = async () => {
    setProcessing('mitm');
    setLogs([]);
    try {
      const response = await fetch('/api/adb/process-mitm', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          packageName,
          device: deviceId,
        }),
      });
      const data = await response.json();
      if (data.zipFilename) {
        downloadFile(data.zipFilename);
      }
    } catch (error) {
      console.error('Error processing MITM:', error);
    }
    setProcessing(null);
  };

  const handleDecompile = async () => {
    setProcessing('decompile');
    setLogs([]);
    try {
      const response = await fetch('/api/adb/decompile', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          packageName,
          device: deviceId,
        }),
      });
      const data = await response.json();
      if (data.zipFilename) {
        downloadFile(data.zipFilename);
      }
    } catch (error) {
      console.error('Error decompiling APK:', error);
    }
    setProcessing(null);
  };

  const downloadFile = (filename: string) => {
    const downloadUrl = `/api/adb/download/${filename}`;
    const link = document.createElement('a');
    link.href = downloadUrl;
    link.download = filename;
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
  };

  return (
    <div className="app">
      <h1>Package: {packageName}</h1>
      <div className="split-layout">
        <div className="left-panel">
          <div className="glass-card">
            <h2>Tools</h2>
            <div className="tool-list">
              {isSplit ? (
                <>
                  <div className={`tool-card ${processing === 'download-split' ? 'processing' : ''}`} onClick={handleDownloadSplit}>
                    <h4>Download Split APKs</h4>
                    <p>Download all split APK files</p>
                    {processing === 'download-split' && <div className="spinner"></div>}
                  </div>
                  <div className={`tool-card ${processing === 'bundle-single' ? 'processing' : ''}`} onClick={handleBundleSingle}>
                    <h4>Bundle to Single APK</h4>
                    <p>Merge split APKs into one APK</p>
                    {processing === 'bundle-single' && <div className="spinner"></div>}
                  </div>
                </>
              ) : (
                <div className={`tool-card ${processing === 'download-split' ? 'processing' : ''}`} onClick={handleDownloadSplit}>
                  <h4>Download APK</h4>
                  <p>Download the APK file</p>
                  {processing === 'download-split' && <div className="spinner"></div>}
                </div>
              )}
              <div className={`tool-card ${processing === 'mitm' ? 'processing' : ''}`} onClick={handleMitm}>
                <h4>APK MITM</h4>
                <p>Inject Man-in-the-Middle capabilities</p>
                {processing === 'mitm' && <div className="spinner"></div>}
              </div>
              <div className={`tool-card ${processing === 'decompile' ? 'processing' : ''}`} onClick={handleDecompile}>
                <h4>Decompile APK</h4>
                <p>Decompile APK to source code</p>
                {processing === 'decompile' && <div className="spinner"></div>}
              </div>
            </div>
            <Link to={`/device/${deviceId}`} className="button">Back to Packages</Link>
          </div>
        </div>
        <div className="right-panel">
          <div className="glass-card logs-panel">
            <h2>Live Logs</h2>
            <div className="logs">
              {logs.map((log, index) => (
                <div key={index} className="log-line">{log}</div>
              ))}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

function App() {
  return (
    <Router>
      <Routes>
        <Route path="/" element={<DeviceList />} />
        <Route path="/device/:deviceId" element={<DeviceDetail />} />
        <Route path="/device/:deviceId/:packageName" element={<PackageTools />} />
      </Routes>
    </Router>
  );
}

export default App;
