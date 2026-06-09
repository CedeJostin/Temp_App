# Este archivo importa todos los modelos para que SQLAlchemy
# los registre en el metadata de Base antes de crear tablas.
from app.models.station import Station        # noqa: F401
from app.models.variable import Variable      # noqa: F401
from app.models.uploaded_file import UploadedFile  # noqa: F401
from app.models.measurement import Measurement     # noqa: F401
from app.models.daily_stats import DailyStats
from app.models.monthly_stats import MonthlyStats
from app.models.heatmap_stats import HeatmapStats
from app.models.distribution_analysis import DistributionAnalysis
from app.models.summary_stats import SummaryStats
from app.models.by_date_stats import ByDateStats
from app.models.annual_profile_stats import AnnualProfileStats
from app.models.combined_stats import CombinedStats